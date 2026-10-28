// electron/tests/hub/m2-integration.test.ts
//
// M2 三段集成（T15，spec 2026-10-24 §1 验收形态）：进程内 SimHub 全仿真
// （ws RPC 路由 + HTTP 数据面双伺服，信封编解码/鉴权/错误码保序全部对齐
// momo-hub 真实实现语义）+ 双 studio 实例 headless（A=leader / B=member）：
//
//   第一段 镜像   A 组队→快照上传（multipart 数据面真 fetch）→ workspace.mirror
//                两段式 → B 真 applyMirrorSnapshot（下载+checksum+解包）→
//                M1 资源补装链真 installHubPackage → 配置落库 → mirror.result
//                定向回 leader + workspace.mirrored 组内广播（资源补装断言）
//   第二段 委派   A task.delegate → SimHub 账本 pending → task.assigned 定向 →
//                B 真委派执行器（真 collab 会话 + 真进度拍端口；回合执行以
//                真 message_events 落库仿真）→ task.report res 对账 →
//                task.progress 实时直转 → done → task.completed（进度实时断言）
//   第三段 查看   A view.workspace/sessions/messages → B 真 ViewServer 真 DB 组装
//                → view.subscribe 尾部订阅 → B 新事件 → view.tail 上行 →
//                view.appended 定向推 A（回放断言）；consent 关闭 → view.*
//                forbidden（「403」语义）→ 重报覆盖恢复
//
// mock 收窄纪律（momo-test-rules）：只 mock 进程边界——electron/logger 模块、
// B 侧回合执行三端口（startTurn/watchTurn/stopSession——真 agent 运行时不在
// 集成面）；DB / 信封 / HTTP / 安装链 / 组装器 / 执行器账本全部真实。
// A 侧快照产物为同构 fixture（manifest.json 根 + tar.gz——构建器真实产出已由
// mirror-applier.test 契约用例锁定；共享进程单 DB 无法同时充当 A 源与 B 目标，
// 见报告说明）。
import { execFileSync } from 'node:child_process';
import crypto, { randomUUID } from 'node:crypto';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// B 侧回合执行边界替身（真 agent 运行时不进集成面；sendUserMessage/getRouterService
// 仅被 wireDelegationRunnerPorts 引用，被下面三端口覆盖——mock 防模块加载期副作用）
vi.mock('../../src/main/im/session-service', () => ({
  sendUserMessage: vi.fn(async () => undefined),
}));
vi.mock('../../src/main/agent/router-bootstrap', () => ({
  getRouterService: vi.fn(() => null),
}));

import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import {
  createHubClient,
  type HubClient,
  type HubResponderResult,
  type WebSocketLike,
  type WsFactory,
} from '../../src/main/hub/client';
import {
  EVT, PROTOCOL_VERSION, RPC, VIEW_RPC,
  encodeEnvelope, isCompatible, parseEnvelope,
  type EventEnvelope, type RequestEnvelope, type ResponseEnvelope,
} from '../../src/main/hub/protocol';
import { MIRROR_WIRE, type MirrorApplyPayload, type MirrorApplyOutcome } from '../../src/main/hub/mirror-wire';
import { VIEW_WIRE } from '../../src/main/hub/view-wire';
import { TASK_WIRE, type TaskReportPayload } from '../../src/main/hub/delegation-wire';
import { createHubConfigStore } from '../../src/main/hub/config-store';
import { setDeviceToken } from '../../src/main/hub/creds';
import { ViewServer } from '../../src/main/hub/view-server';
import { createHubViewSettingsStore } from '../../src/main/hub/view-settings';
import { createHubDelegationSettingsStore } from '../../src/main/hub/delegation-settings';
import { createHubDelegationStore } from '../../src/main/hub/delegation-store';
import { createDelegationRunner, type TurnTerminal } from '../../src/main/hub/delegation-runner';
import { wireDelegationRunnerPorts } from '../../src/main/hub/delegation-ports';
import { applyMirrorSnapshot } from '../../src/main/hub/mirror-applier';
import { listMembers } from '../../src/main/agent/agent-queries';
import { listAgentDefinitions } from '../../src/main/agent/crud';
import { listWorkspaces } from '../../src/main/workspace/crud';
import { __setHubContextResolverForTest } from '../../src/main/resource/hub/momo-hub';
import { __resetTrustedDownloadOriginsForTest } from '../../src/main/marketplace/installer';
import { __resetCatalogCacheForTest } from '../../src/main/marketplace/client';

// ── 节点身份（SimHub 注册面：token→nodeId，镜像真实 hub 的 enrollment 语义）──

const NODE_A = { nodeId: 'node-a', nodeName: '办公室 MacBook', token: 'tok-a' };
const NODE_B = { nodeId: 'node-b', nodeName: '客厅小主机', token: 'tok-b' };
const WORKSPACE_NAME = 'prod-dev';
const AGENT_SLUG = 'hub-int-agent';

// ── 通用件 ─────────────────────────────────────────────────────────────────

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 目录 → tar.gz 归档字节（顶层即成员——与构建器/安装链 fixture 同形） */
function packTarGz(files: Record<string, string | Buffer>): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-int-pack-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    const out = path.join(dir, 'out.tar.gz');
    execFileSync('tar', ['-czf', out, '-C', dir, ...Object.keys(files)]);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 轮询等待条件成立（真实计时器——集成链全真实时序） */
async function until(pred: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等待超时: ${what}`);
}

class FakeSocket extends EventEmitter implements WebSocketLike {
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
    this.emit('to-server', data);
  }
  close(): void {
    this.emit('close', 1000, Buffer.from(''));
  }
  terminate(): void {
    this.emit('close', 1006, Buffer.from(''));
  }
}

// ── SimHub：mock hub 全仿真（ws RPC 路由 + HTTP 数据面） ────────────────────

/** 信封类型直接采用协议单源（encodeEnvelope/parseEnvelope 同一形状域） */
type Env = RequestEnvelope | ResponseEnvelope | EventEnvelope;
type Outcome = { ok: true; payload: unknown } | { ok: false; error: { code: string; message: string } };

interface SimLedgerRow {
  taskId: string; workspaceName: string; targetNodeId: string; byNode: string;
  title: string; status: 'pending' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';
  sessionId: string | null; createdAt: number; updatedAt: number;
}

function canTransition(from: SimLedgerRow['status'], to: SimLedgerRow['status']): boolean {
  if (to === 'cancelled') return from === 'pending' || from === 'running' || from === 'interrupted';
  if (to === 'running') return from === 'pending' || from === 'interrupted';
  if (to === 'done' || to === 'failed') return from === 'running';
  return false;
}

class SimHub {
  private nodes = [NODE_A, NODE_B];
  private online = new Map<string, FakeSocket>();
  private sessions = new Map<FakeSocket, { nodeId: string; helloDone: boolean }>();
  private tokenBySock = new Map<FakeSocket, string>();

  private groups = new Map<string, { id: string; name: string; leader: string; members: Set<string> }>();
  private inviteByCode = new Map<string, string>();
  private groupSeq = 0;
  private inviteSeq = 0;

  snapshots = new Map<string, { bytes: Buffer; checksum: string; manifestJson: string }>();
  resources = new Map<string, { slug: string; type: 'agent'; name: string; version: string; archive: Buffer; checksum: string }>();
  httpLog: Array<{ url: string; auth?: string }> = [];

  private ledger = new Map<string, SimLedgerRow>();
  private taskSeq = 0;

  private mirrorPending = new Map<string, { mirrorId: string; groupId: string; leader: string; target: string; workspaceName: string; snapshotId: string }>();
  private mirrorInFlight = new Set<string>();

  private viewPending = new Map<string, { id: string; method: string; leader: string; target: string; reqId: string; leaderSock: FakeSocket; timer: NodeJS.Timeout }>();
  private viewSubs = new Map<string, { leader: string; target: string; sessionId: string }>();
  /** 断言面：consent 内存态（缺省 true——RM2-9 断线清除回默认） */
  consents = new Map<string, boolean>();

  url = '';
  private server?: http.Server;

  // ── ws 面 ────────────────────────────────────────────────────────────────

  wsFactory: WsFactory = (_url: string, headers: Record<string, string>) => {
    const sock = new FakeSocket();
    const node = this.nodes.find((n) => `Bearer ${n.token}` === headers.authorization);
    sock.on('to-server', (raw: string) => this.onFrame(sock, raw));
    sock.on('close', () => this.onClose(sock));
    queueMicrotask(() => {
      if (!node) {
        sock.emit('close', 4401, Buffer.from('unauthorized'));
        return;
      }
      this.tokenBySock.set(sock, node.token);
      this.sessions.set(sock, { nodeId: node.nodeId, helloDone: false });
      sock.emit('open');
    });
    return sock;
  };

  private nodeOf(sock: FakeSocket): string | null {
    const node = this.nodes.find((n) => n.token === this.tokenBySock.get(sock));
    return node?.nodeId ?? null;
  }

  private send(sock: FakeSocket, env: Env): void {
    // 网络异步语义——绝不在 send() 同栈回包（client.test 同款纪律）
    queueMicrotask(() => sock.emit('message', encodeEnvelope(env)));
  }

  /** 定向投递（离线返回 'offline'——路由器据此立即结算 node_offline） */
  private sendTo(nodeId: string, env: Env): 'sent' | 'offline' {
    const sock = this.online.get(nodeId);
    if (!sock) return 'offline';
    this.send(sock, env);
    return 'sent';
  }

  private reply(sock: FakeSocket, reqId: string, method: string, outcome: Outcome): void {
    this.send(sock, outcome.ok
      ? { v: 1, kind: 'res', id: reqId, method, ok: true, payload: outcome.payload }
      : { v: 1, kind: 'res', id: reqId, method, ok: false, payload: outcome.error });
  }

  private broadcastEvt(env: Env, exceptNodeId?: string): void {
    for (const [nodeId, sock] of this.online) {
      if (nodeId === exceptNodeId) continue;
      this.send(sock, env);
    }
  }

  private onFrame(sock: FakeSocket, raw: string): void {
    const env = parseEnvelope(raw);
    if (!env) return;
    const nodeId = this.nodeOf(sock);
    if (!nodeId) return;
    if (env.kind === 'evt') return; // 上行 evt 忽略（M0 语义）
    if (env.kind === 'res') {
      const session = this.sessions.get(sock);
      if (!session?.helloDone) return;
      if (env.method === TASK_WIRE.report) this.acceptReport(nodeId, env as ResponseEnvelope);
      else if ((Object.values(VIEW_RPC) as readonly string[]).includes(env.method)) this.acceptViewRes(nodeId, env as ResponseEnvelope);
      else this.acceptMirrorReceipt(nodeId, env as ResponseEnvelope);
      return;
    }
    // req
    const session = this.sessions.get(sock);
    if (!session) return;
    if (!session.helloDone && env.method !== RPC.hello) {
      this.reply(sock, env.id, env.method, { ok: false, error: { code: 'unauthorized', message: '必须先完成 hello' } });
      return;
    }
    const req = env as RequestEnvelope;
    switch (req.method) {
      case RPC.hello: {
        // 版本闸门与真实 hub 对齐（M3.0-P2 e：major-only——hub server.ts 用
        // isCompatible(ver, PROTOCOL_VERSION)；此前模拟偏差为严格相等，比真实更严）
        const ver = (req.payload ?? {}) as { protoVer?: unknown };
        const nodeVer = typeof ver.protoVer === 'string' ? ver.protoVer : '';
        if (!isCompatible(nodeVer, PROTOCOL_VERSION)) {
          this.reply(sock, env.id, RPC.hello, { ok: false, error: { code: 'proto_version_mismatch', message: `hub=${PROTOCOL_VERSION} node=${nodeVer}` } });
          return;
        }
        session.helloDone = true;
        this.online.set(nodeId, sock);
        const others = [...this.online.keys()]
          .filter((id) => id !== nodeId)
          .map((id) => ({ nodeId: id, nodeName: this.nodes.find((n) => n.nodeId === id)!.nodeName }));
        this.reply(sock, env.id, RPC.hello, {
          ok: true,
          payload: { hubId: 'sim-hub', protoVer: PROTOCOL_VERSION, serverTime: Date.now(), onlineNodes: others },
        });
        this.broadcastEvt(
          { v: 1, kind: 'evt', method: EVT.nodeOnline, payload: { nodeId, nodeName: this.nameOf(nodeId), at: Date.now() } },
          nodeId,
        );
        return;
      }
      case RPC.ping: {
        const p = (req.payload ?? {}) as { ts?: unknown };
        this.reply(sock, env.id, RPC.ping, { ok: true, payload: { ts: typeof p.ts === 'number' ? p.ts : 0, serverTime: Date.now() } });
        return;
      }
      case RPC.group.create: return this.groupCreate(sock, nodeId, env.id, req);
      case RPC.group.list: return this.groupList(sock, nodeId, env.id);
      case RPC.group.invite: return this.groupInvite(sock, nodeId, env.id, req);
      case RPC.group.join: return this.groupJoin(sock, nodeId, env.id, req);
      case RPC.workspace.mirror: return void this.handleMirror(sock, nodeId, env.id, req);
      case RPC.task.delegate: return void this.handleDelegate(sock, nodeId, env.id, req);
      case RPC.task.cancel: return this.handleCancel(sock, nodeId, env.id, req);
      case RPC.task.list: return this.handleTaskList(sock, nodeId, env.id, req);
      case VIEW_WIRE.consent: return this.handleConsent(sock, nodeId, env.id, req);
      case VIEW_WIRE.tail: return this.handleTail(sock, nodeId, env.id, req);
      default:
        if ((Object.values(VIEW_RPC) as readonly string[]).includes(req.method)) {
          return void this.handleView(sock, nodeId, env.id, req);
        }
        this.reply(sock, env.id, req.method, { ok: false, error: { code: 'unknown_method', message: `hub 不支持的方法: ${req.method}` } });
    }
  }

  // hello 广播用 nodeName 直取（闭包可读性辅助）
  private nameOf(nodeId: string): string {
    return this.nodes.find((n) => n.nodeId === nodeId)!.nodeName;
  }

  private onClose(sock: FakeSocket): void {
    const nodeId = this.nodeOf(sock);
    this.sessions.delete(sock);
    this.tokenBySock.delete(sock);
    if (!nodeId || this.online.get(nodeId) !== sock) return;
    this.online.delete(nodeId);
    this.broadcastEvt({ v: 1, kind: 'evt', method: EVT.nodeOffline, payload: { nodeId, at: Date.now() } });
    // RM2-9：consent 断线清除回默认；RF#1：订阅双侧注销
    this.consents.delete(nodeId);
    for (const [key, s] of [...this.viewSubs]) {
      if (s.leader === nodeId || s.target === nodeId) this.viewSubs.delete(key);
    }
    for (const p of [...this.viewPending.values()]) {
      if (p.target === nodeId) this.settleViewPending(p, { ok: false, error: { code: 'node_offline', message: '目标节点在处理期间离线' } });
      else if (p.leader === nodeId) this.settleViewPending(p, { ok: false, error: { code: 'internal', message: '请求方已断开' } });
    }
    for (const p of [...this.mirrorPending.values()]) {
      if (p.target !== nodeId) continue;
      this.mirrorPending.delete(p.mirrorId);
      this.mirrorInFlight.delete(`${p.workspaceName}\u0000${p.target}`);
      this.sendTo(p.leader, { v: 1, kind: 'res', id: p.mirrorId, method: MIRROR_WIRE.result, ok: false, payload: { mirrorId: p.mirrorId, code: 'node_offline', message: '目标节点在镜像应用期间离线' } });
    }
    for (const row of this.ledger.values()) {
      if (row.targetNodeId !== nodeId || (row.status !== 'pending' && row.status !== 'running')) continue;
      if (!canTransition(row.status, 'interrupted')) continue;
      row.status = 'interrupted';
      row.updatedAt = Date.now();
      this.sendTo(row.byNode, { v: 1, kind: 'evt', method: EVT.taskInterrupted, payload: { taskId: row.taskId } });
    }
  }

  // ── 组管理 ───────────────────────────────────────────────────────────────

  private groupCreate(sock: FakeSocket, nodeId: string, reqId: string, req: RequestEnvelope): void {
    const p = (req.payload ?? {}) as { groupName?: unknown };
    const groupName = typeof p.groupName === 'string' && p.groupName.trim().length > 0 ? p.groupName.trim() : null;
    if (!groupName) {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'bad_request', message: 'groupName 缺失' } });
      return;
    }
    const id = `g-${++this.groupSeq}`;
    this.groups.set(id, { id, name: groupName, leader: nodeId, members: new Set([nodeId]) });
    this.broadcastEvt({ v: 1, kind: 'evt', method: EVT.groupChanged, payload: { groupId: id, kind: 'joined', nodeId } });
    this.reply(sock, reqId, req.method, { ok: true, payload: { groupId: id, nodeId } });
  }

  private groupList(sock: FakeSocket, nodeId: string, reqId: string): void {
    const groups = [...this.groups.values()]
      .filter((g) => g.members.has(nodeId))
      .map((g) => ({
        groupId: g.id,
        groupName: g.name,
        leaderNodeId: g.leader,
        members: [...g.members].map((m) => ({ nodeId: m, name: this.nameOf(m), online: this.online.has(m) })),
      }));
    this.reply(sock, reqId, RPC.group.list, { ok: true, payload: { groups } });
  }

  private groupInvite(sock: FakeSocket, nodeId: string, reqId: string, req: RequestEnvelope): void {
    const p = (req.payload ?? {}) as { groupId?: unknown };
    const g = typeof p.groupId === 'string' ? this.groups.get(p.groupId) : undefined;
    if (!g || g.leader !== nodeId) {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'forbidden', message: '仅组长可生成邀请码' } });
      return;
    }
    const code = `code-${++this.inviteSeq}`;
    this.inviteByCode.set(code, g.id);
    this.reply(sock, reqId, req.method, { ok: true, payload: { inviteCode: code } });
  }

  private groupJoin(sock: FakeSocket, nodeId: string, reqId: string, req: RequestEnvelope): void {
    const p = (req.payload ?? {}) as { inviteCode?: unknown };
    const groupId = typeof p.inviteCode === 'string' ? this.inviteByCode.get(p.inviteCode) : undefined;
    const g = groupId ? this.groups.get(groupId) : undefined;
    if (!g) {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'not_found', message: '邀请码无效或已撤销' } });
      return;
    }
    g.members.add(nodeId);
    this.broadcastEvt({ v: 1, kind: 'evt', method: EVT.groupChanged, payload: { groupId: g.id, kind: 'joined', nodeId } });
    this.reply(sock, reqId, req.method, { ok: true, payload: { groupId: g.id } });
  }

  /** 请求者与目标共同组（请求者须为组长——真实 hub 外围守卫语义） */
  private ledGroupOf(leader: string, target: string): { id: string; leader: string; members: Set<string> } | null {
    for (const g of this.groups.values()) {
      if (g.leader === leader && g.members.has(target)) return g;
    }
    return null;
  }

  // ── 镜像两段式 ───────────────────────────────────────────────────────────

  private async handleMirror(sock: FakeSocket, nodeId: string, reqId: string, req: RequestEnvelope): Promise<void> {
    const p = (req.payload ?? {}) as Record<string, unknown>;
    const groupId = typeof p.groupId === 'string' ? p.groupId : '';
    const targetNodeId = typeof p.targetNodeId === 'string' ? p.targetNodeId : '';
    const workspaceName = typeof p.workspaceName === 'string' ? p.workspaceName : '';
    const snapshotId = typeof p.snapshotId === 'string' ? p.snapshotId : '';
    if (!groupId || !targetNodeId || !workspaceName || !snapshotId || p.strategy !== 'replace') {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'bad_request', message: 'groupId/targetNodeId/workspaceName/snapshotId 缺失或 strategy 非 replace' } });
      return;
    }
    const g = this.groups.get(groupId);
    if (!g || !g.members.has(nodeId)) {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'not_found', message: '工作组不存在' } });
      return;
    }
    if (g.leader !== nodeId || !g.members.has(targetNodeId)) {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'forbidden', message: '目标节点不是本组成员' } });
      return;
    }
    if (!this.snapshots.has(snapshotId)) {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'not_found', message: '快照不存在' } });
      return;
    }
    const mirrorId = randomUUID();
    const inFlightKey = `${workspaceName}\u0000${targetNodeId}`;
    if (this.mirrorInFlight.has(inFlightKey)) {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'conflict', message: 'mirror_in_progress：同工作空间对该目标已有在途镜像' } });
      return;
    }
    this.mirrorInFlight.add(inFlightKey);
    const applyPayload: MirrorApplyPayload = { mirrorId, snapshotId, workspaceName, strategy: 'replace' };
    if (p.confirm === true) applyPayload.confirm = true;
    const sent = this.sendTo(targetNodeId, { v: 1, kind: 'req', id: mirrorId, method: MIRROR_WIRE.apply, payload: applyPayload });
    if (sent === 'offline') {
      this.mirrorInFlight.delete(inFlightKey);
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'node_offline', message: '目标节点不在线' } });
      return;
    }
    this.mirrorPending.set(mirrorId, { mirrorId, groupId: g.id, leader: nodeId, target: targetNodeId, workspaceName, snapshotId });
    this.reply(sock, reqId, req.method, { ok: true, payload: { accepted: true, mirrorId } });
  }

  private acceptMirrorReceipt(fromNodeId: string, res: ResponseEnvelope): void {
    const pending = this.mirrorPending.get(res.id);
    if (!pending || fromNodeId !== pending.target) return;
    this.mirrorPending.delete(pending.mirrorId);
    this.mirrorInFlight.delete(`${pending.workspaceName}\u0000${pending.target}`);
    if (res.ok) {
      const raw = (res.payload ?? {}) as { appliedResources?: unknown; unresolvedRefs?: unknown };
      const appliedResources = Array.isArray(raw.appliedResources) && raw.appliedResources.every((s) => typeof s === 'string')
        ? (raw.appliedResources as string[])
        : [];
      const unresolvedRefs = Array.isArray(raw.unresolvedRefs) && raw.unresolvedRefs.every((s) => typeof s === 'string')
        ? (raw.unresolvedRefs as string[])
        : undefined;
      const g = this.groups.get(pending.groupId);
      const evt: EventEnvelope = {
        v: 1, kind: 'evt', method: EVT.workspaceMirrored,
        payload: {
          groupId: pending.groupId, targetNodeId: pending.target, workspaceName: pending.workspaceName,
          snapshotId: pending.snapshotId, appliedResources, ...(unresolvedRefs ? { unresolvedRefs } : {}),
        },
      };
      if (g) for (const m of g.members) this.sendTo(m, evt);
      this.sendTo(pending.leader, {
        v: 1, kind: 'res', id: pending.mirrorId, method: MIRROR_WIRE.result, ok: true,
        payload: { mirrorId: pending.mirrorId, appliedResources, ...(unresolvedRefs ? { unresolvedRefs } : {}) },
      });
      return;
    }
    const raw = (res.payload ?? {}) as { code?: unknown; message?: unknown; diffSummary?: unknown };
    this.sendTo(pending.leader, {
      v: 1, kind: 'res', id: pending.mirrorId, method: MIRROR_WIRE.result, ok: false,
      payload: {
        mirrorId: pending.mirrorId,
        code: typeof raw.code === 'string' ? raw.code : 'internal',
        message: typeof raw.message === 'string' ? raw.message : '目标节点应用失败',
        ...(raw.diffSummary && typeof raw.diffSummary === 'object' ? { diffSummary: raw.diffSummary } : {}),
      },
    });
  }

  // ── 委派账本 ─────────────────────────────────────────────────────────────

  private async handleDelegate(sock: FakeSocket, nodeId: string, reqId: string, req: RequestEnvelope): Promise<void> {
    const p = (req.payload ?? {}) as Record<string, unknown>;
    const g = typeof p.groupId === 'string' ? this.groups.get(p.groupId) : undefined;
    const targetNodeId = typeof p.targetNodeId === 'string' ? p.targetNodeId : '';
    const workspaceName = typeof p.workspaceName === 'string' ? p.workspaceName : '';
    const t = p.task as { title?: unknown; prompt?: unknown; agentSlug?: unknown } | undefined;
    if (!g || g.leader !== nodeId || !g.members.has(targetNodeId) || !workspaceName
      || !t || typeof t.title !== 'string' || typeof t.prompt !== 'string') {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'forbidden', message: '仅组长可向本组成员委派任务' } });
      return;
    }
    const taskId = `t-${++this.taskSeq}`;
    const now = Date.now();
    this.ledger.set(taskId, {
      taskId, workspaceName, targetNodeId, byNode: nodeId,
      title: t.title, status: 'pending', sessionId: null, createdAt: now, updatedAt: now,
    });
    const sent = this.sendTo(targetNodeId, {
      v: 1, kind: 'evt', method: EVT.taskAssigned,
      payload: {
        taskId, workspaceName,
        task: { title: t.title, prompt: t.prompt, ...(typeof t.agentSlug === 'string' && t.agentSlug !== '' ? { agentSlug: t.agentSlug } : {}) },
        byNode: nodeId,
      },
    });
    if (sent === 'offline') {
      this.ledger.delete(taskId);
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'node_offline', message: '目标节点不在线' } });
      return;
    }
    this.reply(sock, reqId, req.method, { ok: true, payload: { taskId } });
  }

  private handleCancel(sock: FakeSocket, nodeId: string, reqId: string, req: RequestEnvelope): void {
    const p = (req.payload ?? {}) as { taskId?: unknown };
    const row = typeof p.taskId === 'string' ? this.ledger.get(p.taskId) : undefined;
    if (!row) {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'not_found', message: '任务不存在' } });
      return;
    }
    if (row.byNode !== nodeId) {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'forbidden', message: '仅委派发起者可取消' } });
      return;
    }
    if (!canTransition(row.status, 'cancelled')) {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'conflict', message: `任务已终态（${row.status}）不可取消` } });
      return;
    }
    row.status = 'cancelled';
    row.updatedAt = Date.now();
    this.sendTo(row.targetNodeId, { v: 1, kind: 'evt', method: EVT.taskCancelled, payload: { taskId: row.taskId } });
    this.reply(sock, reqId, req.method, { ok: true, payload: { ok: true } });
  }

  private handleTaskList(sock: FakeSocket, _nodeId: string, reqId: string, req: RequestEnvelope): void {
    const p = (req.payload ?? {}) as { groupId?: unknown; status?: unknown };
    const groupId = typeof p.groupId === 'string' ? p.groupId : null;
    const status = typeof p.status === 'string' ? p.status : null;
    const tasks = [...this.ledger.values()]
      .filter((r) => (groupId ? r.byNode === _nodeId || r.targetNodeId === _nodeId : true))
      .filter((r) => (status ? r.status === status : true))
      .map((r) => ({
        taskId: r.taskId, workspaceName: r.workspaceName, targetNodeId: r.targetNodeId,
        status: r.status, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt,
      }));
    this.reply(sock, reqId, req.method, { ok: true, payload: { tasks } });
  }

  /** task.report 上行（res 信封 id=taskId 对账——hub acceptReport 语义） */
  private acceptReport(fromNodeId: string, res: ResponseEnvelope): void {
    if (!res.ok) return;
    const report = res.payload as Partial<TaskReportPayload> | null;
    if (!report || (report.status !== 'running' && report.status !== 'done' && report.status !== 'failed')) return;
    const row = this.ledger.get(res.id);
    if (!row || fromNodeId !== row.targetNodeId) return;

    if (report.status === row.status) {
      if (report.status === 'running') {
        if (report.sessionId && report.sessionId !== row.sessionId) {
          row.sessionId = report.sessionId;
          row.updatedAt = Date.now();
        }
        this.forwardProgress(row, report);
      }
      return;
    }
    if (!canTransition(row.status, report.status)) return;
    row.status = report.status;
    if (report.sessionId !== undefined) row.sessionId = report.sessionId ?? row.sessionId;
    row.updatedAt = Date.now();

    if (report.status === 'running') {
      this.forwardProgress(row, report);
      return;
    }
    const terminal: { taskId: string; reason?: string } = { taskId: row.taskId };
    if (report.status === 'failed' && report.reason !== undefined) terminal.reason = report.reason;
    this.sendTo(row.byNode, {
      v: 1, kind: 'evt', method: report.status === 'done' ? EVT.taskCompleted : EVT.taskFailed,
      payload: terminal,
    });
  }

  private forwardProgress(row: SimLedgerRow, report: Partial<TaskReportPayload>): void {
    this.sendTo(row.byNode, {
      v: 1, kind: 'evt', method: EVT.taskProgress,
      payload: {
        taskId: row.taskId,
        sessionId: row.sessionId ?? '',
        lastSeq: report.progress?.lastSeq ?? 0,
        excerpt: report.progress?.excerpt || '（无文本增量）',
      },
    });
  }

  // ── 远程查看 ─────────────────────────────────────────────────────────────

  private handleConsent(sock: FakeSocket, nodeId: string, reqId: string, req: RequestEnvelope): void {
    const p = (req.payload ?? {}) as { allowed?: unknown };
    if (typeof p.allowed !== 'boolean') {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'bad_request', message: 'allowed 必须为布尔' } });
      return;
    }
    this.consents.set(nodeId, p.allowed);
    this.reply(sock, reqId, req.method, { ok: true, payload: { ok: true } });
  }

  private async handleView(sock: FakeSocket, nodeId: string, reqId: string, req: RequestEnvelope): Promise<void> {
    const p = (req.payload ?? {}) as Record<string, unknown>;
    const targetNodeId = typeof p.targetNodeId === 'string' && p.targetNodeId.length > 0 ? p.targetNodeId : null;
    if (!targetNodeId) {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'bad_request', message: 'targetNodeId 缺失或超长' } });
      return;
    }
    const sessionId = typeof p.sessionId === 'string' && p.sessionId.length > 0 ? p.sessionId : null;
    if ((req.method === VIEW_RPC.subscribe || req.method === VIEW_RPC.unsubscribe) && !sessionId) {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'bad_request', message: 'sessionId 缺失或超长' } });
      return;
    }
    if (!this.ledGroupOf(nodeId, targetNodeId)) {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'forbidden', message: '仅组长可远程查看目标节点（需与其同组）' } });
      return;
    }
    if (req.method === VIEW_RPC.unsubscribe) {
      // 清理路径豁免 consent：本地注销先行；目标离线/超时仍 ok（幂等语义）
      this.viewSubs.delete(`${nodeId}\u0000${targetNodeId}\u0000${sessionId}`);
      if (!this.online.has(targetNodeId)) {
        this.reply(sock, reqId, req.method, { ok: true, payload: { ok: true } });
        return;
      }
    } else if (this.consents.get(targetNodeId) === false) {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'forbidden', message: '目标节点已关闭本组查看' } });
      return;
    }

    const id = randomUUID();
    const timer = setTimeout(() => {
      const pending = this.viewPending.get(id);
      if (!pending) return;
      this.viewPending.delete(id);
      this.reply(sock, reqId, req.method, req.method === VIEW_RPC.unsubscribe
        ? { ok: true, payload: { ok: true } }
        : { ok: false, error: { code: 'internal', message: '目标节点响应超时' } });
    }, 10_000);
    timer.unref?.();
    this.viewPending.set(id, { id, method: req.method, leader: nodeId, target: targetNodeId, reqId, leaderSock: sock, timer });
    const sent = this.sendTo(targetNodeId, { v: 1, kind: 'req', id, method: req.method, payload: p });
    if (sent === 'offline') {
      const pending = this.viewPending.get(id);
      if (pending) this.settleViewPending(pending, { ok: false, error: { code: 'node_offline', message: '目标节点不在线' } });
    }
    if (req.method === VIEW_RPC.subscribe) {
      // 订阅登记（目标 res ok 后生效语义近似——同键去重幂等）
      this.viewSubs.set(`${nodeId}\u0000${targetNodeId}\u0000${sessionId}`, { leader: nodeId, target: targetNodeId, sessionId: sessionId! });
    }
  }

  private acceptViewRes(fromNodeId: string, res: ResponseEnvelope): void {
    const pending = this.viewPending.get(res.id);
    if (!pending || fromNodeId !== pending.target) return;
    if (res.ok) {
      this.settleViewPending(pending, { ok: true, payload: res.payload });
    } else {
      const raw = (res.payload ?? {}) as { code?: unknown; message?: unknown };
      this.settleViewPending(pending, {
        ok: false,
        error: {
          code: typeof raw.code === 'string' ? raw.code : 'internal',
          message: typeof raw.message === 'string' && raw.message.length > 0 ? raw.message : '目标节点处理失败',
        },
      });
    }
  }

  private settleViewPending(p: { id: string; reqId: string; method: string; leaderSock: FakeSocket; timer: NodeJS.Timeout }, outcome: Outcome): void {
    clearTimeout(p.timer);
    this.viewPending.delete(p.id);
    this.reply(p.leaderSock, p.reqId, p.method, outcome);
  }

  private handleTail(sock: FakeSocket, nodeId: string, reqId: string, req: RequestEnvelope): void {
    const p = (req.payload ?? {}) as { sessionId?: unknown; events?: unknown };
    if (typeof p.sessionId !== 'string' || !Array.isArray(p.events) || p.events.length === 0) {
      this.reply(sock, reqId, req.method, { ok: false, error: { code: 'bad_request', message: 'tail 载荷异形' } });
      return;
    }
    const subs = [...this.viewSubs.values()].filter((s) => s.target === nodeId && s.sessionId === p.sessionId && this.ledGroupOf(s.leader, s.target));
    if (subs.length > 0) {
      const evt: EventEnvelope = { v: 1, kind: 'evt', method: EVT.viewAppended, payload: { sessionId: p.sessionId, events: p.events } };
      for (const s of subs) this.sendTo(s.leader, evt);
    }
    this.reply(sock, reqId, req.method, { ok: true, payload: { ok: true } });
  }

  // ── HTTP 数据面 ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.onHttp(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    const addr = server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${addr.port}`;
  }

  private authorized(req: http.IncomingMessage): boolean {
    const auth = req.headers.authorization;
    return auth === `Bearer ${NODE_A.token}` || auth === `Bearer ${NODE_B.token}`;
  }

  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '';
    this.httpLog.push({ url, auth: req.headers.authorization });
    if (!this.authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (url === '/resources/catalog') {
      const items = [...this.resources.values()].map((r) => ({
        slug: r.slug, type: r.type, name: r.name, version: r.version,
        author: 'sim-hub', description: '集成测试资源', readme: '# sim',
        tags: ['m2'], category: 'dev', iconEmoji: '🤖', verificationStatus: 'unverified',
        downloadUrl: `${this.url}/resources/${r.slug}/${r.version}/download`,
        checksum: r.checksum, sizeBytes: r.archive.length,
        publishedAt: 1_700_000_000_000, versions: [r.version],
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '1.0.0', updatedAt: '2026-10-24T00:00:00.000Z', items }));
      return;
    }
    const dl = url.match(/^\/resources\/([^/]+)\/([^/]+)\/download$/);
    if (dl) {
      const r = this.resources.get(decodeURIComponent(dl[1]!));
      if (!r) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(r.archive.length) });
      res.end(r.archive);
      return;
    }
    if (url === '/workspaces/snapshots' && req.method === 'POST') {
      // multipart（manifest part 在前——与 studio uploadSnapshot 定序契约一致）；
      // 服务端流式自算 checksum（C6）
      try {
        const web = new Request(`http://sim${url}`, {
          method: 'POST',
          headers: req.headers as Record<string, string>,
          body: req as unknown as ReadableStream,
          duplex: 'half',
        });
        const form = await web.formData();
        const manifestPart = form.get('manifest');
        const payloadPart = form.get('payload');
        if (!(manifestPart instanceof File) || !(payloadPart instanceof File)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_manifest' }));
          return;
        }
        const manifestJson = await manifestPart.text();
        const bytes = Buffer.from(await payloadPart.arrayBuffer());
        const manifest = JSON.parse(manifestJson) as { workspaceName?: string; version?: string };
        if (typeof manifest.workspaceName !== 'string' || typeof manifest.version !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_manifest' }));
          return;
        }
        const snapshotId = randomUUID();
        const checksum = sha256(bytes);
        this.snapshots.set(snapshotId, { bytes, checksum, manifestJson });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ snapshotId, checksum }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_manifest' }));
      }
      return;
    }
    const snap = url.match(/^\/workspaces\/snapshots\/([^/]+)\/download$/);
    if (snap && req.method === 'GET') {
      const s = this.snapshots.get(decodeURIComponent(snap[1]!));
      if (!s) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(s.bytes.length),
        'X-Checksum-Sha256': s.checksum,
      });
      res.end(s.bytes);
      return;
    }
    res.writeHead(404);
    res.end();
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      for (const sock of this.sessions.keys()) sock.terminate();
      this.server?.closeAllConnections();
      this.server?.close(() => resolve());
    });
  }
}

// ── 测试环境脚手架 ─────────────────────────────────────────────────────────
let tmpRoot = '';
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};

const sim = new SimHub();
let clientA: HubClient;
let clientB: HubClient;
let viewServerB: ViewServer;
let runnerB: ReturnType<typeof createDelegationRunner>;
let viewSettings: ReturnType<typeof createHubViewSettingsStore>;

/** A 侧事件捕获（hub 定向→leader 的全部推送） */
const aEvents: EventEnvelope[] = [];
const aMirrorResults: Array<{ mirrorId: string; ok: boolean; payload: Record<string, unknown> }> = [];
const aProgress = (): Array<{ taskId: string; sessionId: string; lastSeq: number; excerpt: string }> =>
  aEvents.filter((e) => e.method === EVT.taskProgress).map((e) => e.payload as { taskId: string; sessionId: string; lastSeq: number; excerpt: string });

/** DB 种子：会话消息 + message_events（view-server.test 同款插入形态） */
function insertMessage(sessionId: string, sender: string, eventType: string, body: string): void {
  const msgId = `msg-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, sender, event_type, body, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 'done', ?, ?)`,
    )
    .run(msgId, sessionId, sender, eventType, now, now);
  getDb()
    .prepare(
      'INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(`evt-${randomUUID().slice(0, 8)}`, msgId, Math.floor(Math.random() * 1e6), eventType, JSON.stringify(eventType === 'final' ? { body } : eventType === 'text_delta' ? { delta: body } : { toolName: body }), now);
}

/** B 侧回合执行仿真：任务书 user 消息 + agent 流事件真落库；watchTurn 定时终态 */
const PROMPT = '请排查并修复登录超时问题，输出修复说明。';
const turnTimers = new Map<string, NodeJS.Timeout>();
function fakeStartTurn(input: { sessionId: string; body: string }): Promise<void> {
  insertMessage(input.sessionId, 'owner', 'final', input.body);
  insertMessage(input.sessionId, 'agent', 'text_delta', '正在排查登录超时…');
  insertMessage(input.sessionId, 'agent', 'tool_call_start', 'web_search');
  insertMessage(input.sessionId, 'agent', 'final', '已定位超时原因：连接池耗尽，修复已提交。');
  return Promise.resolve();
}
function fakeWatchTurn(sessionId: string, onTerminal: (t: TurnTerminal) => void): () => void {
  const timer = setTimeout(() => {
    turnTimers.delete(sessionId);
    onTerminal({ status: 'done' });
  }, 160);
  timer.unref?.();
  turnTimers.set(sessionId, timer);
  return () => {
    clearTimeout(timer);
    turnTimers.delete(sessionId);
  };
}

/** B 侧被动应答器（index.ts handleHubRequest 同款映射——mirror.apply + view.*） */
async function bResponder(req: RequestEnvelope): Promise<HubResponderResult> {
  if (req.method === MIRROR_WIRE.apply) {
    const outcome: MirrorApplyOutcome = await applyMirrorSnapshot(req.payload as MirrorApplyPayload);
    if (outcome.ok) {
      return {
        ok: true,
        payload: {
          appliedResources: outcome.appliedResources,
          ...('unresolvedRefs' in outcome ? { unresolvedRefs: outcome.unresolvedRefs } : {}),
        },
      };
    }
    return {
      ok: false,
      payload: {
        code: outcome.code,
        message: outcome.message,
        ...('diffSummary' in outcome && outcome.diffSummary ? { diffSummary: outcome.diffSummary } : {}),
      },
    };
  }
  if ((Object.values(VIEW_RPC) as readonly string[]).includes(req.method)) {
    return viewServerB.handleViewRequest(req);
  }
  return { ok: false, payload: { code: 'unknown_method', message: `节点不支持的方法: ${req.method}` } };
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-m2-int-'));
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
  __resetTrustedDownloadOriginsForTest();
  __resetCatalogCacheForTest();

  await sim.start();
  // B 侧 hub 配置 + 凭证（applier 快照下载链经真 config/keychain 读取）
  createHubConfigStore(getDb()).write({ hubUrl: sim.url, nodeName: NODE_B.nodeName, nodeId: NODE_B.nodeId });
  await setDeviceToken(NODE_B.token);
  // installHubPackage 数据面上下文（M1 链 catalog/download 鉴权）
  __setHubContextResolverForTest(async () => ({ hubUrl: sim.url, deviceToken: NODE_B.token }));

  // 资源 fixture：hub 分发 agent 包（parseAgentManifest 可解析形态——e2e 同款）
  const manifestYaml = [
    'apiVersion: v1',
    'kind: AgentDefinition',
    'metadata:',
    `  name: ${AGENT_SLUG}`,
    `  slug: ${AGENT_SLUG}`,
    '  version: 1.0.0',
    '  description: hub 分发的集成演示 agent',
    "  iconEmoji: '🤖'",
    'spec:',
    '  type: standalone',
    '  runtime: declarative',
    '  declarative:',
    '    systemPrompt: 你是来自 momo-hub 的集成演示 agent',
    '    model:',
    '      provider: anthropic',
    '      model: claude-3-5-sonnet',
    '',
  ].join('\n');
  const archive = packTarGz({ 'manifest.yaml': manifestYaml });
  sim.resources.set(AGENT_SLUG, { slug: AGENT_SLUG, type: 'agent', name: '集成演示 Agent', version: '1.0.0', archive, checksum: sha256(archive) });

  // B 侧域层（真 DB）：ViewServer（20ms 尾部拍）+ 委派执行器（回合三端口仿真）
  viewSettings = createHubViewSettingsStore(getDb());
  viewServerB = new ViewServer({ clientGetter: () => clientB, settings: () => viewSettings.read(), tailTickMs: 20 });
  const delegationSettings = createHubDelegationSettingsStore(getDb());
  const wired = wireDelegationRunnerPorts({
    clientGetter: () => clientB,
    selfNodeId: () => NODE_B.nodeId,
    settings: () => delegationSettings.read(),
  });
  runnerB = createDelegationRunner({
    ports: {
      ...wired,
      startTurn: fakeStartTurn,
      watchTurn: fakeWatchTurn,
      stopSession: () => undefined,
    },
    store: createHubDelegationStore(getDb()),
    tickMs: 50,
  });

  // 双实例连接（A 先上线——hello 快照空，B 上线经 node.online 事件进入 A 的在线面）
  clientA = createHubClient({
    url: 'ws://sim/ws', nodeName: NODE_A.nodeName, deviceToken: NODE_A.token,
    ws: sim.wsFactory,
    onStateChange: () => undefined,
    onEvent: (e) => {
      aEvents.push(e);
    },
    onUnsolicitedRes: (res) => {
      if (res.method === MIRROR_WIRE.result) {
        const p = (res.payload ?? {}) as { mirrorId?: unknown };
        if (typeof p.mirrorId === 'string') aMirrorResults.push({ mirrorId: p.mirrorId, ok: res.ok, payload: p });
      }
    },
  });
  clientA.start();
  await until(() => clientA.state() === 'online', 5000, 'clientA online');
  // M3.0-P2 版本管道：hello 应答 protoVer 落连接态（SimHub HelloRes 已带 protoVer）
  expect(clientA.hubProtoVer()).toBe(PROTOCOL_VERSION);

  clientB = createHubClient({
    url: 'ws://sim/ws', nodeName: NODE_B.nodeName, deviceToken: NODE_B.token,
    ws: sim.wsFactory,
    onStateChange: (state) => {
      // reportViewConsent 同款：上线即上报本机查看开关（缺省 true）
      if (state === 'online') void clientB.request(VIEW_WIRE.consent, { allowed: viewSettings.read().allowGroupView }).catch(() => undefined);
    },
    onEvent: (e) => {
      if (e.method === EVT.taskAssigned) {
        const p = e.payload as { taskId?: unknown; workspaceName?: unknown; byNode?: unknown; task?: { title?: unknown; prompt?: unknown; agentSlug?: unknown } };
        if (typeof p.taskId === 'string' && typeof p.workspaceName === 'string' && typeof p.byNode === 'string'
          && p.task && typeof p.task.title === 'string' && typeof p.task.prompt === 'string') {
          void runnerB.handleAssigned({
            taskId: p.taskId,
            workspaceName: p.workspaceName,
            byNode: p.byNode,
            task: { title: p.task.title, prompt: p.task.prompt, ...(typeof p.task.agentSlug === 'string' ? { agentSlug: p.task.agentSlug } : {}) },
          });
        }
      }
      if (e.method === EVT.taskCancelled) {
        const p = e.payload as { taskId?: unknown };
        if (typeof p.taskId === 'string') runnerB.handleCancelled({ taskId: p.taskId });
      }
    },
    onRequest: bResponder,
  });
  clientB.start();
  await until(() => clientB.state() === 'online', 5000, 'clientB online');
  await until(() => sim.consents.get(NODE_B.nodeId) === true, 5000, 'B consent 上报');
});

afterAll(async () => {
  runnerB?.destroy();
  viewServerB?.destroy();
  clientA?.stop();
  clientB?.stop();
  for (const t of turnTimers.values()) clearTimeout(t);
  await sim.close();
  __setHubContextResolverForTest(null);
  __resetTrustedDownloadOriginsForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
});

// ── 跨段共享状态（段间串行链） ─────────────────────────────────────────────

let groupId = '';
let mirrorId = '';
let delegatedSessionId = '';
let delegatedTaskId = '';

// ══════════════════════════════════════════════════════════════════════════
// 第一段：组队 → 快照上传 → 镜像两段式 → 资源补装（资源补装断言）
// ══════════════════════════════════════════════════════════════════════════

describe('M2 三段集成（SimHub 全仿真 + 双实例 headless）', () => {
  it('第一段 镜像：A 组队→上传→mirror 两段式→B 补装落库→result 定向 + mirrored 广播', async () => {
    // 组队：A 创建 + 邀请，B 凭码入组
    const created = await clientA.request<{ groupId: string; nodeId: string }>(RPC.group.create, { groupName: 'm2-int' });
    expect(created.nodeId).toBe(NODE_A.nodeId);
    groupId = created.groupId;
    const invite = await clientA.request<{ inviteCode: string }>(RPC.group.invite, { groupId });
    const joined = await clientB.request<{ groupId: string }>(RPC.group.join, { inviteCode: invite.inviteCode });
    expect(joined.groupId).toBe(groupId);

    // A 在线面经 node.online 事件融合（presence 快照 + 增量）
    const list = await clientA.request<{ groups: Array<{ groupId: string; leaderNodeId: string; members: Array<{ nodeId: string; online: boolean }> }> }>(RPC.group.list, {});
    const mine = list.groups.find((g) => g.groupId === groupId)!;
    expect(mine.leaderNodeId).toBe(NODE_A.nodeId);
    expect(mine.members.find((m) => m.nodeId === NODE_B.nodeId)?.online).toBe(true);

    // 快照构建（同构 fixture：manifest.json 根 + agent 资源引用）→ 真 multipart 上传
    const manifest = {
      workspaceName: WORKSPACE_NAME,
      version: 'v1',
      resources: [{ type: 'agent', slug: AGENT_SLUG }],
      config: {
        agentMembers: [{ name: '集成演示', slug: AGENT_SLUG }],
        teams: [],
        mcpEnabled: [],
        skills: [],
        pluginsEnabled: [],
        providerRefs: [],
        prefs: {},
      },
    };
    const archive = packTarGz({ 'manifest.json': JSON.stringify(manifest) });
    const form = new FormData();
    form.append('manifest', new Blob([JSON.stringify(manifest)], { type: 'application/json' }), 'manifest.json');
    form.append('payload', new Blob([archive], { type: 'application/gzip' }), 'payload.tar.gz');
    const uploadRes = await fetch(`${sim.url}/workspaces/snapshots`, {
      method: 'POST',
      headers: { authorization: `Bearer ${NODE_A.token}` },
      body: form,
    });
    expect(uploadRes.status).toBe(201);
    const uploaded = (await uploadRes.json()) as { snapshotId: string; checksum: string };
    expect(uploaded.checksum).toBe(sha256(archive)); // C6：服务端权威 checksum 与本地复算一致

    // 镜像两段式第一段：受理回执
    const accept = await clientA.request<{ accepted: boolean; mirrorId: string }>(RPC.workspace.mirror, {
      groupId, targetNodeId: NODE_B.nodeId, workspaceName: WORKSPACE_NAME,
      snapshotId: uploaded.snapshotId, strategy: 'replace',
    });
    expect(accept.accepted).toBe(true);
    mirrorId = accept.mirrorId;

    // 第二段：B 应用（真下载+checksum+解包+M1 补装+配置落库）→ result 定向回 A
    await until(() => aMirrorResults.some((r) => r.mirrorId === mirrorId), 10_000, 'mirror.result 到达 A');
    const result = aMirrorResults.find((r) => r.mirrorId === mirrorId)!;
    expect(result.ok).toBe(true);
    expect((result.payload.appliedResources as string[])).toContain(`agent/${AGENT_SLUG}`);

    // workspace.mirrored 组内广播（A 与 B 均可消费——本断言锚 A 侧）
    await until(() => aEvents.some((e) => e.method === EVT.workspaceMirrored), 5000, 'workspace.mirrored 广播');
    const mirrored = aEvents.find((e) => e.method === EVT.workspaceMirrored)!.payload as Record<string, unknown>;
    expect(mirrored.targetNodeId).toBe(NODE_B.nodeId);
    expect(mirrored.workspaceName).toBe(WORKSPACE_NAME);

    // B 侧落库断言（真 DB）：工作空间 + agent 定义入库（M1 补装链）+ 成员挂载
    const ws = listWorkspaces().find((w) => w.name === WORKSPACE_NAME);
    expect(ws).toBeDefined();
    const def = listAgentDefinitions().find((d) => d.slug === AGENT_SLUG);
    expect(def).toBeDefined();
    const members = listMembers(ws!.id);
    expect(members).toHaveLength(1);
    expect(members[0]!.agentDefinitionId).toBe(def!.id);
    const accRow = getDb()
      .prepare('SELECT item_type FROM installed_packages WHERE item_id = ?')
      .get(`hub:${AGENT_SLUG}`) as { item_type: string } | undefined;
    expect(accRow?.item_type).toBe('agent');

    // 数据面鉴权与真下载（B 的 token 打快照下载；catalog/download 打资源链）
    expect(sim.httpLog.some((r) => r.url.includes('/workspaces/snapshots/') && r.url.endsWith('/download') && r.auth === `Bearer ${NODE_B.token}`)).toBe(true);
    expect(sim.httpLog.some((r) => r.url === '/resources/catalog' && r.auth === `Bearer ${NODE_B.token}`)).toBe(true);
    expect(sim.httpLog.some((r) => r.url.includes(`/resources/${AGENT_SLUG}/1.0.0/download`))).toBe(true);
  });

  // ════════════════════════════════════════════════════════════════════════
  // 第二段：委派 → 实时进度 → 完成（进度实时断言）
  // ════════════════════════════════════════════════════════════════════════

  it('第二段 委派：A delegate→B 真执行器建会执行→进度实时直转→done→账本回填', async () => {
    const res = await clientA.request<{ taskId: string }>(RPC.task.delegate, {
      groupId,
      targetNodeId: NODE_B.nodeId,
      workspaceName: WORKSPACE_NAME,
      task: { title: '修复登录超时', prompt: PROMPT, agentSlug: AGENT_SLUG },
    });
    delegatedTaskId = res.taskId;

    // 完成事件到达（B 执行器：首拍 running → 进度拍 → done）
    await until(() => aEvents.some((e) => e.method === EVT.taskCompleted && (e.payload as { taskId: string }).taskId === delegatedTaskId), 10_000, 'task.completed 到达 A');

    // 进度实时断言：≥2 拍（首拍 lastSeq=0 + 尾部增量拍 lastSeq>0）、lastSeq 单调不丢、excerpt 恒非空
    const beats = aProgress().filter((p) => p.taskId === delegatedTaskId);
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats[0]!.lastSeq).toBe(0);
    expect(beats[0]!.excerpt).toContain('请排查并修复登录超时'); // 首拍 excerpt = 任务书首句
    const withTail = beats.filter((b) => b.lastSeq > 0);
    expect(withTail.length).toBeGreaterThanOrEqual(1);
    expect(withTail[0]!.excerpt.length).toBeGreaterThan(0);
    for (let i = 1; i < beats.length; i++) {
      expect(beats[i]!.lastSeq).toBeGreaterThanOrEqual(beats[i - 1]!.lastSeq); // RF#5 单调
    }
    // 进度拍全部先于完成事件（顺序：progress…→completed）
    const completedIdx = aEvents.findIndex((e) => e.method === EVT.taskCompleted && (e.payload as { taskId: string }).taskId === delegatedTaskId);
    const lastProgressIdx = aEvents.map((e) => e.method).lastIndexOf(EVT.taskProgress);
    expect(lastProgressIdx).toBeLessThan(completedIdx);

    // 账本：hub 侧 done（TaskRecord 七字段——协议面无 sessionId；会话 id 经
    // task.progress 载荷到达 leader，MC1 跨节点投影的消费契约）
    const listRes = await clientA.request<{ tasks: Array<{ taskId: string; status: string; targetNodeId: string; title: string }> }>(RPC.task.list, { groupId });
    const row = listRes.tasks.find((t) => t.taskId === delegatedTaskId)!;
    expect(row.status).toBe('done');
    expect(row.title).toBe('修复登录超时');
    const withSession = beats.filter((b) => b.sessionId !== '');
    expect(withSession.length).toBeGreaterThanOrEqual(1);
    delegatedSessionId = withSession[0]!.sessionId;

    // B 本地账本（kv_store 'hub_delegations'——真 delegation-store）同步终态
    const ledgerRow = getDb()
      .prepare("SELECT value FROM kv_store WHERE key = 'hub_delegations'")
      .get() as { value: string } | undefined;
    const localLedger = JSON.parse(ledgerRow?.value ?? '{}') as Record<string, { state?: string }>;
    expect(localLedger[delegatedTaskId]?.state).toBe('done');
  });

  // ════════════════════════════════════════════════════════════════════════
  // 第三段：查看回放 + 尾部订阅 + consent 关闭 forbidden（回放断言 + 403 语义）
  // ════════════════════════════════════════════════════════════════════════

  it('第三段 查看：四数据面→订阅尾部实时追加→退订停发→consent 关闭 forbidden→重报恢复', async () => {
    // 概览（七字段——真 ViewServer 真 DB 组装）
    const overview = await clientA.request<{ overview: { name: string; sessionCount: number }; agentMembers: Array<{ name: string; agentSlug?: string }>; resourcesSummary: { agent: number } }>(
      VIEW_RPC.workspace, { targetNodeId: NODE_B.nodeId, workspaceName: WORKSPACE_NAME },
    );
    expect(overview.overview.name).toBe(WORKSPACE_NAME);
    expect(overview.overview.sessionCount).toBeGreaterThanOrEqual(1);
    expect(overview.agentMembers[0]!.agentSlug).toBe(AGENT_SLUG);
    expect(overview.resourcesSummary.agent).toBeGreaterThanOrEqual(1);

    // 会话列表：委派会话在列（MC1 跨节点投影）
    const sessions = await clientA.request<{ sessions: Array<{ sessionId: string; title: string; lastSeq: number }> }>(
      VIEW_RPC.sessions, { targetNodeId: NODE_B.nodeId, workspaceName: WORKSPACE_NAME, limit: 50 },
    );
    const delegated = sessions.sessions.find((s) => s.sessionId === delegatedSessionId);
    expect(delegated).toBeDefined();
    expect(delegated!.title).toBe('修复登录超时');
    expect(delegated!.lastSeq).toBeGreaterThan(0);

    // 消息回放页：任务书与工具前缀投影在列（seq 升序）
    const page = await clientA.request<{ messages: Array<{ seq: number; content: string }>; hasMore: boolean }>(
      VIEW_RPC.messages, { targetNodeId: NODE_B.nodeId, sessionId: delegatedSessionId, fromSeq: 0, limit: 50 },
    );
    const contents = page.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes('请排查并修复登录超时'))).toBe(true);
    expect(contents.some((c) => c.includes('调用工具 web_search'))).toBe(true);
    for (let i = 1; i < page.messages.length; i++) {
      expect(page.messages[i]!.seq).toBeGreaterThan(page.messages[i - 1]!.seq);
    }

    // 尾部订阅 → B 新事件 → view.appended 实时推 A（回放断言）
    const sub = await clientA.request<{ ok: boolean }>(VIEW_RPC.subscribe, { targetNodeId: NODE_B.nodeId, sessionId: delegatedSessionId });
    expect(sub.ok).toBe(true);
    insertMessage(delegatedSessionId, 'agent', 'final', '修复说明：已扩容连接池并加超时兜底。');
    await until(
      () => aEvents.some((e) => e.method === EVT.viewAppended && (e.payload as { sessionId: string }).sessionId === delegatedSessionId),
      5000,
      'view.appended 到达 A',
    );
    const appended = aEvents.find((e) => e.method === EVT.viewAppended && (e.payload as { sessionId: string }).sessionId === delegatedSessionId)!.payload as { events: Array<{ content: string }> };
    expect(appended.events.some((ev) => ev.content.includes('已扩容连接池'))).toBe(true);

    // 退订停发（RF#1 无悬挂订阅）
    await clientA.request(VIEW_RPC.unsubscribe, { targetNodeId: NODE_B.nodeId, sessionId: delegatedSessionId });
    await new Promise((r) => setTimeout(r, 150));
    const appendedCount = aEvents.filter((e) => e.method === EVT.viewAppended).length;
    insertMessage(delegatedSessionId, 'agent', 'final', '退订后的静默事件。');
    await new Promise((r) => setTimeout(r, 200));
    expect(aEvents.filter((e) => e.method === EVT.viewAppended).length).toBe(appendedCount);

    // consent 关闭（B 写开关 + 即时上报——hubSetViewSettings online 路径同款两步）
    viewSettings.write({ allowGroupView: false });
    await clientB.request(VIEW_WIRE.consent, { allowed: false });
    expect(sim.consents.get(NODE_B.nodeId)).toBe(false);
    // 「403」：hub 对 view.* 一律 forbidden（人话原文保序透传）
    await expect(
      clientA.request(VIEW_RPC.workspace, { targetNodeId: NODE_B.nodeId, workspaceName: WORKSPACE_NAME }),
    ).rejects.toThrow(/已关闭本组查看/);
    // 退订豁免：consent 关闭不阻断清理路径
    const unsub = await clientA.request<{ ok: boolean }>(VIEW_RPC.unsubscribe, { targetNodeId: NODE_B.nodeId, sessionId: delegatedSessionId });
    expect(unsub.ok).toBe(true);

    // 重报覆盖恢复（RM2-9：重连/变更重报使查看恢复）
    viewSettings.write({ allowGroupView: true });
    await clientB.request(VIEW_WIRE.consent, { allowed: true });
    const restored = await clientA.request<{ overview: { name: string } }>(VIEW_RPC.workspace, { targetNodeId: NODE_B.nodeId, workspaceName: WORKSPACE_NAME });
    expect(restored.overview.name).toBe(WORKSPACE_NAME);
  });
});
