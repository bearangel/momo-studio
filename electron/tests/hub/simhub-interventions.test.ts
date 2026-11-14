// electron/tests/hub/simhub-interventions.test.ts
//
// 任务生命周期 v2 P2 S10a：SimHub 全链契约测试——studio 桥接件 ↔ 协议级
// SimHub（内存假 hub）的首个接线验证。studio 依赖树只有 momo-hub-protocol
// （hub 服务器实现 momo-hub 包不可达），故 SimHub 形态 = **协议级**：不自建
// ws、不重新实现 hub 业务逻辑（状态机仲裁 / first_wins / 定向路由均为 hub 域），
// hub 行为由「账本记录 + 模拟事件回执」代表——每个回执 payload 从已记录的
// RPC 载荷投影生成，消费侧全部经真实 handler 导出函数：
//
//   S2 桥 createRemoteInterveneHandler（request_created → task.intervene /
//      run_submitted → task.report submitted；离线降级里程碑）
//   S3 handleInterventionAnswered（远端代答 → answerHuman 统一路由）
//   S4 handleTaskAccepted / handleTaskRejected（远端验收/打回 → 复用写路径）
//   S5 handleTaskInterventionMirror / handleTaskSubmittedMirror（发起方镜像）
//   S6 answerHumanRouted / acceptTaskRouted / rejectTaskRouted（跨节点路由）
//      + setMirrorAnswerForwarder / setRemoteTerminalForwarder 生产同形转发器
//      （ipc/index.ts 装配的载荷映射逐字复刻，经 SimHub client.request 边界）
//   S7 reconcileOnReconnect（断线重连对账幂等收敛）
//   dispatch submitRoutedTask（真链派发：twoPhase 戳 out + 跟踪会话）
//
// 四场景编排（spec 2026-11-13 §8 双向时序）：
//   1. lf 全链：dispatch → intervene → 发起方代答 → worker 提交 → 发起方验收
//      → 双侧 completed（先本地后远端顺序锁）
//   2. reject 返工：同链至 submitted → 打回 → run#2 再提交 → accept；
//      hub 侧 runNo 语义（事件 runNo=2 透传到镜像幂等键/里程碑 meta）
//   3. peer 全链：draft 派发 → worker intervene → 发起方镜像行主进程拒答
//      （peer 人话）→ worker 本地自答 → submitted → peer 验收权 accept
//   4. 断线重连：intervene 送达后断线 → 离线新请求降级里程碑 + worker 自答
//      → 发起方远端代答（自有连接，SimHub 直调代表）→ 重连对账收敛
//      → 提交（在线）→ 二次对账补收 submitted → accept → 双侧终态；
//      全程幂等计数断言（里程碑/行数/RPC 计数）
//   S9 残留：hub:taskList handler 直调——1.11 投影 runNo/submittedAt/acceptedAt
//      原样透传断言（ipc.test.ts 的 electron/hub-index mock 边界同款）
//
// mock 边界（momo-test-rules #5，S2-S8 既有纪律）：hub client request/sendRes
// 边界（SimHub 内置 vi.fn）/ router 唤醒 / renderer push / electron API 假件
// / hub/index（ipc.handlers 静态依赖——S9 块专用，ipc.test.ts 同面）；DB 真实
// （worker-intervene-bridge.test.ts 同款 AP_USER_DATA_DIR 临时库）。
//
// 单进程双角色约定（S7 test #6「自委派双行共存」同款）：发起方外派行
// （delegation_role='out'，routing→远端）与 worker 承接行（'in' 或 peer 承接
// 形 role NULL+routing→本机）共库共存、共享 delegation_id，消费面按角色分叉。
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── mock 边界打桩（worker-answer-consume.test.ts / ipc.test.ts 同款）──────────
const { routeUserChatMock, pushSessionMessageMock, mockBroadcastDeny } = vi.hoisted(() => ({
  routeUserChatMock: vi.fn<(input: unknown) => Promise<void>>(),
  pushSessionMessageMock: vi.fn<(msg: unknown) => void>(),
  mockBroadcastDeny: vi.fn((): boolean => false),
}));
vi.mock('../../src/main/agent/router-bootstrap', () => ({
  getRouterService: () => ({ routeUserChat: routeUserChatMock }),
}));
vi.mock('../../src/main/agent/stream-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/agent/stream-relay')>()),
  pushSessionMessage: (msg: unknown) => pushSessionMessageMock(msg),
}));

// S9 块专用：hub/ipc.handlers 顶层 import { ipcMain } from 'electron' 与
// './index'（hubRequest 等）——electron 捕获 + hub/index 最小 mock 面
// （ipc.test.ts 逐字同款，presence 供 projectHumanListRows 的 originNodeNameOf）
const simhubShared = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  presenceNodes: [{ nodeId: 'node-worker', nodeName: 'Worker 节点' }],
  taskListResponse: { tasks: [] as Array<Record<string, unknown>> },
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: unknown[]) => unknown) =>
      simhubShared.ipcHandlers.set(ch, fn),
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: () => undefined } }],
  },
}));
vi.mock('../../src/main/hub/index', () => ({
  initHub: vi.fn(),
  stopHub: vi.fn(),
  hubGetStatus: vi.fn(() => ({
    configured: false, state: 'disconnected', hubUrl: null, nodeName: null,
    nodeId: null, lastError: null, lastErrorCode: null, hubProtoVer: null,
  })),
  hubConfigure: vi.fn(async (input: { hubUrl: string }) => ({
    configured: true, state: 'connecting', hubUrl: input.hubUrl, nodeName: 'a',
    nodeId: null, lastError: null, lastErrorCode: null, hubProtoVer: null,
  })),
  hubEnroll: vi.fn(async () => ({
    configured: true, state: 'connecting', hubUrl: 'http://h', nodeName: 'a',
    nodeId: 'n1', lastError: null, lastErrorCode: null, hubProtoVer: null,
  })),
  hubForget: vi.fn(async () => undefined),
  replayPresenceSeed: vi.fn(),
  hubGetPresenceNodes: vi.fn(() => simhubShared.presenceNodes),
  hubRequest: vi.fn(
    async (method: string, _payload: unknown) =>
      method === 'task.list' ? simhubShared.taskListResponse : {},
  ),
  hubProtoVer: vi.fn(() => '1.11.0'),
  hubGetDelegationSettings: vi.fn(() => ({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: 15 })),
  hubSetDelegationSettings: vi.fn(async (input: { acceptTasks: boolean; maxConcurrent: number; hitlTimeoutMinutes: number }) => input),
  hubGetWorkspaceDirSettings: vi.fn(() => ({ rootDir: null, defaultRootDir: '/d/workspaces', effectiveRootDir: '/d/workspaces' })),
  hubSetWorkspaceDirSettings: vi.fn(async (input: { rootDir: string | null }) => input),
  hubGetViewSettings: vi.fn(() => ({ allowGroupView: true })),
  hubSetViewSettings: vi.fn(async (input: { allowGroupView: boolean }) => input),
  hubDelegationBoard: vi.fn(() => ({ progress: {}, received: [] })),
  hubLocalWaiting: vi.fn(() => ({})),
  hubMarkDelegationCancelled: vi.fn(),
  hubListMirrorRegistry: vi.fn(() => []),
}));

// electron API 假件（write-blocked 推卡边界——worker-answer-consume 同款）
const mockSend = vi.fn();
import { __setElectronApisForTest } from '../../src/main/electron-access';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, updateTask, getTask, type TaskRow } from '../../src/main/storage/tasks/repo';
import { insertSession, getSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { getActiveRun, listRuns } from '../../src/main/storage/tasks/runs-repo';
import { insertTaskWithRelations } from '../../src/main/task/relations';
import { deriveBlockedBy } from '../../src/main/storage/tasks/dependencies-repo';
import {
  getHumanRequest,
  findRemoteMirrorRequest,
  listByTask,
  listRequests,
} from '../../src/main/storage/tasks/human-requests-repo';
import {
  setRemoteInterveneSink,
  setHumanAnswerKickoff,
  requestHuman,
  startRun,
  submitRun,
  acceptTask,
  answerHuman,
} from '../../src/main/task/lifecycle-runs';
import { sendSystemKickoffMessage } from '../../src/main/task/human-answer-inject';
import { setWriteDeniedBroadcaster } from '../../src/main/sandbox/write-blocked-emit';
import {
  createRemoteInterveneHandler,
  handleInterventionAnswered,
  handleTaskAccepted,
  handleTaskRejected,
  handleTaskInterventionMirror,
  handleTaskSubmittedMirror,
  type WorkerTerminalConsumePorts,
} from '../../src/main/hub/remote-intervene-bridge';
import { reconcileOnReconnect } from '../../src/main/hub/reconnect-reconcile';
import { submitRoutedTask, type DispatchSubmitPorts, type SubmitRoutedTaskInput } from '../../src/main/hub/dispatch-submit';
import { ensureTrackingSession } from '../../src/main/hub/tracking-session';
import { TASK_RPC, TASK_HITL_REQUIRED_MINOR, type InterventionAnswer, type InterventionRecord, type TaskRecord } from '../../src/main/hub/protocol';
import { TASK_WIRE } from '../../src/main/hub/delegation-wire';
import {
  answerHumanRouted,
  setMirrorAnswerForwarder,
  projectHumanListRows,
  type MirrorAnswerForwardInput,
} from '../../src/main/task/human.ipc.handlers';
import {
  acceptTaskRouted,
  rejectTaskRouted,
  setRemoteTerminalForwarder,
  type RemoteTerminalForwardInput,
} from '../../src/main/task/ipc.handlers';
import { registerHubIpc } from '../../src/main/hub/ipc.handlers';
import type { HubClient } from '../../src/main/hub/client';

const SELF_NODE = 'node-self';
const WORKER_NODE = 'node-worker';
const WORKER_NODE_NAME = 'Worker 节点';
const LF_GROUP = 'g-lf';
const PEER_GROUP = 'g-peer';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-simhub-interventions-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

setWriteDeniedBroadcaster(mockBroadcastDeny);

beforeAll(() => {
  __setElectronApisForTest({
    BrowserWindow: {
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }],
    },
    ipcMain: { handle: vi.fn() },
  });
});
afterAll(() => {
  __setElectronApisForTest(null);
});

// ── SimHub：协议级内存假 hub（账本记录 + 回执生成——零 hub 业务逻辑）──────────

/** 组清单快照行（DispatchSubmitPorts.listGroups 成员面） */
interface SimGroup {
  groupId: string;
  groupName: string;
  mode?: 'leader-follower' | 'peer';
  leaderNodeId?: string;
  members: Array<{ nodeId: string; name: string; online: boolean; protoVer?: string; bound?: boolean }>;
}

/** hub 委派账本行（delegations 投影最小面） */
interface SimLedgerEntry {
  taskId: string;
  groupId: string;
  status: 'pending' | 'running' | 'submitted' | 'done';
  runNo: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  submittedAt?: number;
  acceptedAt?: number;
  /** worker report submitted 的 deliverable（H7：reason JSON 解析为纯对象时透传） */
  deliverable?: Record<string, unknown>;
}

/** 干预账本行（delegation_interventions 投影——InterventionRecord + 归属委派） */
type SimIntervention = InterventionRecord & { taskId: string };

/**
 * SimHub：request/sendTo 边界的内存实现。**只记录 + 生成回执**——不做状态机
 * 仲裁、不做 first_wins、不做定向路由（均为 hub 域，本测试以回执直调消费方
 * handler 代表其效果）。发起方在断线窗口内的远端动作经 applyAnswer 直改账本
 * （生产语义：发起方节点自有连接，不经本机 worker client）。
 */
class SimHub {
  online = true;
  readonly protoVer = `1.${TASK_HITL_REQUIRED_MINOR}.0`;
  private seq = 0;
  private readonly ledger = new Map<string, SimLedgerEntry>();
  private readonly interventions = new Map<string, SimIntervention>();
  private readonly groups: SimGroup[] = [];

  /** client.request 边界（mock 面——断言载体） */
  readonly requestMock = vi.fn(async (method: string, payload: unknown): Promise<unknown> => {
    if (!this.online) throw new Error('simhub: 连接已断开');
    if (method === TASK_RPC.delegate) {
      const p = payload as { groupId: string; targetNodeId: string; task: { title: string } };
      this.seq += 1;
      const taskId = `dl-${this.seq}`;
      const now = Date.now();
      this.ledger.set(taskId, {
        taskId, groupId: p.groupId, status: 'pending', runNo: 1, title: p.task.title,
        createdAt: now, updatedAt: now,
      });
      return { taskId };
    }
    if (method === TASK_RPC.intervene) {
      const p = payload as { taskId: string; intervention: InterventionRecord };
      this.interventions.set(p.intervention.interventionId, {
        ...p.intervention, status: 'pending', taskId: p.taskId, createdAt: Date.now(),
      });
      return { interventionId: p.intervention.interventionId };
    }
    if (method === TASK_RPC.answer) {
      const p = payload as { taskId: string; interventionId: string; answer?: InterventionAnswer };
      this.applyAnswer(p.taskId, p.interventionId, p.answer ?? {}, 'node-self');
      return { disposition: 'answered' };
    }
    if (method === TASK_RPC.accept) {
      const p = payload as { taskId: string };
      const e = this.ledger.get(p.taskId);
      if (e === undefined) throw new Error(`simhub: 未知委派 ${p.taskId}`);
      e.status = 'done';
      e.acceptedAt = Date.now();
      e.updatedAt = e.acceptedAt;
      return { runNo: e.runNo };
    }
    if (method === TASK_RPC.reject) {
      const p = payload as { taskId: string; reason: string };
      const e = this.ledger.get(p.taskId);
      if (e === undefined) throw new Error(`simhub: 未知委派 ${p.taskId}`);
      e.status = 'running';
      e.runNo += 1; // 协议：打回 → run_no+1（新 run 号；submitted_at 保留历史）
      e.updatedAt = Date.now();
      return { runNo: e.runNo };
    }
    if (method === TASK_RPC.interventions) {
      const p = payload as { taskId?: string } | null;
      return { interventions: this.interventionsSnapshot(p?.taskId) };
    }
    if (method === TASK_RPC.list) {
      const p = payload as { status?: string; groupId?: string } | null;
      return { tasks: this.listTasks(p?.status) };
    }
    throw new Error(`simhub: 未预期 RPC ${method}`);
  });

  /** client.sendRes 边界（task.report 单向上报） */
  readonly sendResMock = vi.fn(
    (id: string, method: string, payload: unknown): boolean => {
      if (!this.online) return false;
      if (method !== TASK_WIRE.report) throw new Error(`simhub: 未预期 res 方法 ${method}`);
      const p = payload as { status: string; runNo?: number; reason?: string };
      const e = this.ledger.get(id);
      if (e === undefined) throw new Error(`simhub: 未知委派 ${id}`);
      if (p.status !== 'submitted') return true; // 旧通道上报（本测试不产生）
      e.status = 'submitted';
      if (typeof p.runNo === 'number') e.runNo = p.runNo;
      e.submittedAt = Date.now();
      e.updatedAt = e.submittedAt;
      // H7 通道约定：reason 为纯对象 JSON 时作 deliverable 透传
      if (typeof p.reason === 'string') {
        try {
          const parsed: unknown = JSON.parse(p.reason);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            e.deliverable = parsed as Record<string, unknown>;
          }
        } catch {
          // 非对象载荷不透传（hub 同语义）
        }
      }
      return true;
    },
  );

  client(): HubClient {
    return {
      start: () => undefined,
      stop: () => undefined,
      state: () => (this.online ? ('online' as const) : ('disconnected' as const)),
      hubProtoVer: () => this.protoVer,
      request: this.requestMock as unknown as HubClient['request'],
      sendRes: this.sendResMock as unknown as HubClient['sendRes'],
    } as HubClient;
  }

  /** 发起方远端代答（自有连接——不经本机 client；断线窗口内仍可达） */
  applyAnswer(taskId: string, interventionId: string, answer: InterventionAnswer, byNode: string): void {
    const rec = this.interventions.get(interventionId);
    if (rec === undefined) throw new Error(`simhub: 未知干预 ${interventionId}`);
    rec.status = 'answered';
    rec.answer = answer;
    rec.answeredBy = byNode;
    rec.answeredAt = Date.now();
    rec.taskId = taskId;
  }

  /** 发起方远端验收（自有连接——task.accept 的账本效果直改；断线窗口内仍可达，
   *  task.accepted 事件未达 worker = 阶段 1.5 的 accepted-miss 形态） */
  applyAccept(taskId: string): void {
    const e = this.ledger.get(taskId);
    if (e === undefined) throw new Error(`simhub: 未知委派 ${taskId}`);
    e.status = 'done';
    e.acceptedAt = Date.now();
    e.updatedAt = e.acceptedAt;
  }

  addGroup(g: SimGroup): void {
    this.groups.push(g);
  }

  listGroups(): SimGroup[] {
    return this.groups;
  }

  interventionsSnapshot(taskId?: string): InterventionRecord[] {
    return [...this.interventions.values()].filter(
      (r) => taskId === undefined || r.taskId === taskId,
    );
  }

  /** 账本 → 协议 TaskRecord 投影（1.11 字段 runNo/submittedAt/acceptedAt 全带） */
  listTasks(status?: string): TaskRecord[] {
    return [...this.ledger.values()]
      .filter((e) => status === undefined || e.status === status)
      .map((e) => ({
        taskId: e.taskId,
        workspaceName: 'Test',
        targetNodeId: WORKER_NODE,
        groupId: e.groupId,
        status: e.status,
        title: e.title,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        runNo: e.runNo,
        ...(e.submittedAt !== undefined ? { submittedAt: e.submittedAt } : {}),
        ...(e.acceptedAt !== undefined ? { acceptedAt: e.acceptedAt } : {}),
      }));
  }

  delegationId(): string {
    const ids = [...this.ledger.keys()];
    if (ids.length === 0) throw new Error('simhub: 账本为空（未派发）');
    return ids[ids.length - 1]!;
  }

  // ── 模拟事件回执生成（hub 定向事件 payload——从账本投影，消费方直调）──────

  interventionEvent(interventionId: string): unknown {
    const rec = this.interventions.get(interventionId);
    if (rec === undefined) throw new Error(`simhub: 未知干预 ${interventionId}`);
    return {
      taskId: rec.taskId,
      intervention: {
        interventionId: rec.interventionId,
        runNo: rec.runNo,
        kind: rec.kind,
        title: rec.title,
        prompt: rec.prompt,
        ...(rec.payload !== undefined ? { payload: rec.payload } : {}),
        ...(rec.options !== undefined ? { options: rec.options } : {}),
        ...(rec.deadlineAt !== undefined ? { deadlineAt: rec.deadlineAt } : {}),
      },
    };
  }

  interventionAnsweredEvent(interventionId: string): unknown {
    const rec = this.interventions.get(interventionId);
    if (rec === undefined) throw new Error(`simhub: 未知干预 ${interventionId}`);
    return {
      taskId: rec.taskId,
      interventionId: rec.interventionId,
      answer: rec.answer ?? {},
      answeredBy: rec.answeredBy ?? 'node-self',
    };
  }

  submittedEvent(): unknown {
    const e = this.ledger.get(this.delegationId());
    if (e === undefined || e.status !== 'submitted') throw new Error('simhub: 账本非 submitted');
    return {
      taskId: e.taskId,
      runNo: e.runNo,
      ...(e.deliverable !== undefined ? { deliverable: e.deliverable } : {}),
    };
  }

  acceptedEvent(): unknown {
    const e = this.ledger.get(this.delegationId());
    if (e === undefined || e.status !== 'done') throw new Error('simhub: 账本非 done');
    return { taskId: e.taskId, runNo: e.runNo };
  }

  rejectedEvent(reason: string): unknown {
    const e = this.ledger.get(this.delegationId());
    if (e === undefined) throw new Error('simhub: 账本为空');
    return { taskId: e.taskId, runNo: e.runNo, reason };
  }
}

// ── 测试基建 ─────────────────────────────────────────────────────────────────

let sim: SimHub;
let workerExecSessionId = '';
/** S6 终端转发时的本地状态快照（先本地后远端顺序锁断言载体） */
const terminalCalls: Array<RemoteTerminalForwardInput & { statusAtCall: string }> = [];

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  workerExecSessionId = insertSession({ workspaceId: 'ws1', title: '执行', kind: 'chat' }).id;
  sim = new SimHub();
  sim.addGroup({
    groupId: LF_GROUP,
    groupName: '主从组',
    mode: 'leader-follower',
    leaderNodeId: SELF_NODE,
    members: [
      { nodeId: SELF_NODE, name: '本机', online: true, protoVer: sim.protoVer },
      { nodeId: WORKER_NODE, name: WORKER_NODE_NAME, online: true, protoVer: sim.protoVer },
    ],
  });
  sim.addGroup({
    groupId: PEER_GROUP,
    groupName: '平行组',
    mode: 'peer',
    members: [{ nodeId: WORKER_NODE, name: WORKER_NODE_NAME, online: true, protoVer: sim.protoVer, bound: true }],
  });
  setHumanAnswerKickoff(sendSystemKickoffMessage);
  terminalCalls.length = 0;
  routeUserChatMock.mockReset().mockResolvedValue(undefined);
  pushSessionMessageMock.mockClear();
  mockBroadcastDeny.mockClear();
  mockSend.mockClear();
  simhubShared.ipcHandlers.clear();
  simhubShared.taskListResponse = { tasks: [] };

  // S2 桥装配（生产同形：DB 面直连真实库，client 惰性取用）
  setRemoteInterveneSink(
    createRemoteInterveneHandler({
      clientGetter: () => sim.client(),
      selfNodeId: () => SELF_NODE,
      getTask: (id) => getTask(id),
      getActiveRun: (id) => getActiveRun(id),
      findActiveTaskByExecutionSession: (sessionId) =>
        (getDb()
          .prepare(
            'SELECT id FROM tasks WHERE execution_session_id = ? ORDER BY created_at DESC LIMIT 5',
          )
          .all(sessionId) as Array<{ id: string }>)
          .map((r) => getTask(r.id))
          .filter(
            (t): t is TaskRow =>
              t !== null && !['completed', 'failed', 'cancelled'].includes(t.status),
          )[0] ?? null,
      acceptTask: async (id) => {
        await acceptTask(id);
      },
    }),
  );

  // S6 转发器装配（ipc/index.ts:124-160 生产载荷映射逐字复刻，经 SimHub 边界）
  setMirrorAnswerForwarder(async (input: MirrorAnswerForwardInput) => {
    const { delegationId, remoteId, answer } = input;
    const decision =
      answer.decision === 'deny' || answer.decision === 'reject'
        ? 'deny'
        : answer.decision !== undefined
          ? 'approve'
          : undefined;
    const text =
      answer.reason !== undefined && answer.reason !== ''
        ? [answer.text, answer.reason].filter((s) => s !== undefined && s !== '').join('\n')
        : answer.text;
    const interventionAnswer: InterventionAnswer = {
      ...(decision !== undefined ? { decision } : {}),
      ...(text !== undefined && text !== '' ? { text } : {}),
      ...(answer.selected !== undefined ? { selected: answer.selected } : {}),
      ...(answer.completed !== undefined ? { completed: answer.completed } : {}),
    };
    const res = await sim.client().request<{ disposition: 'granted' | 'denied' | 'stale' | 'answered' }>(
      TASK_RPC.answer,
      {
        taskId: delegationId,
        decision: decision ?? 'approve',
        interventionId: remoteId,
        answer: interventionAnswer,
      },
      undefined,
    );
    return res.disposition;
  });
  setRemoteTerminalForwarder(async (input) => {
    const origin = getDb()
      .prepare(`SELECT id FROM tasks WHERE delegation_id = ? AND delegation_role = 'out'`)
      .get(input.delegationId) as { id: string } | undefined;
    terminalCalls.push({
      ...input,
      statusAtCall: origin !== undefined ? (getTask(origin.id)?.status ?? '?') : '?',
    });
    await sim.client().request(
      input.outcome === 'accepted' ? TASK_RPC.accept : TASK_RPC.reject,
      input.outcome === 'accepted'
        ? { taskId: input.delegationId }
        : { taskId: input.delegationId, reason: input.reason },
      undefined,
    );
  });
});

afterEach(() => {
  setRemoteInterveneSink(null);
  setMirrorAnswerForwarder(null);
  setRemoteTerminalForwarder(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 等 fire-and-forget 的 RPC promise 链收敛（S2 桥 intervene/report 为 void promise） */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** 会话种 leader 成员（唤醒目标——worker-answer-consume.test.ts 同款） */
function seedSessionLeader(sessionId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, icon_emoji)
     VALUES ('def-1', 'Worker', 'worker', '1', 'p', 'm', '🤖')`,
  ).run();
  db.prepare(
    `INSERT INTO workspace_agent_members
       (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
     VALUES ('inst-1', 'ws1', 'def-1', '@inst-1:s', 1)`,
  ).run();
  addSessionMember(sessionId, 'inst-1', true);
}

/** delegation_milestone 行（结构化 meta 断言载体） */
function milestoneRows(): Array<{ task_id: string | null; body: string; meta: Record<string, unknown> }> {
  return (
    getDb()
      .prepare(`SELECT task_id, body, context_json FROM messages WHERE event_type = 'delegation_milestone'`)
      .all() as Array<{ task_id: string | null; body: string; context_json: string | null }>
  ).map((r) => ({
    task_id: r.task_id,
    body: r.body,
    meta: r.context_json === null ? {} : (JSON.parse(r.context_json) as Record<string, unknown>),
  }));
}

function milestoneCount(): number {
  return (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE event_type = 'delegation_milestone'`)
      .get() as { n: number }
  ).n;
}

/** 会话内 system 行（注入断言载体） */
function systemRows(sessionId: string): Array<{ sender: string; event_type: string; body: string }> {
  return getDb()
    .prepare(`SELECT sender, event_type, body FROM messages WHERE session_id = ? AND sender = 'system'`)
    .all(sessionId) as Array<{ sender: string; event_type: string; body: string }>;
}

/** SimHub client.request 调用按方法过滤 */
function rpcCalls(method: string): Array<unknown> {
  return sim.requestMock.mock.calls
    .filter(([m]) => m === method)
    .map(([, payload]) => payload);
}

/** 派发端口（dispatch-ports.ts 生产装配的 SimHub 网络面版本——DB 面全真） */
function dispatchPorts(): DispatchSubmitPorts {
  return {
    listGroups: async () => sim.listGroups(),
    getTeamSnapshot: () => null,
    hubProtoVer: () => sim.protoVer,
    listDelegations: async () => sim.listTasks().map((t) => ({
      taskId: t.taskId, targetNodeId: t.targetNodeId, status: t.status,
    })),
    listMirrorRegistry: () => [],
    delegate: (brief) =>
      sim.client().request<{ taskId: string }>(TASK_RPC.delegate, brief, undefined),
    createLocalTask: () => {
      throw new Error('SimHub 测试不走 local 路由');
    },
    createRemoteTask: (input) =>
      insertTaskWithRelations(
        {
          workspaceId: input.workspaceId,
          title: input.title,
          description: input.description,
          creatorUserId: '@owner:home',
          status: input.status,
          ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
          routing: input.routing,
          ...(input.targetTeamId !== undefined ? { targetTeamId: input.targetTeamId } : {}),
          ...(input.draft === true ? { origin: 'peer_draft' as const } : {}),
        },
        { dependsOn: input.dependsOn ?? [] },
      ),
    deriveBlockedBy: (taskId) => deriveBlockedBy([taskId]).get(taskId) ?? [],
    updateDelegationLink: (taskId, delegationId, routing, delegationStamp) => {
      updateTask(taskId, { delegationId, routing, ...delegationStamp });
    },
    ensureTrackingSession: (input) =>
      ensureTrackingSession(input, { listGroups: async () => sim.listGroups() }),
  };
}

/** lf 派发链（场景 1/2/4 前缀）：真 submitRoutedTask 派发 + worker 承接行 + 活动 run */
async function seedLfDispatch(): Promise<{ out: TaskRow; worker: TaskRow; dl: string }> {
  const input: SubmitRoutedTaskInput = {
    workspaceId: 'ws1',
    workspaceName: 'Test',
    title: '跨节点 HITL 任务',
    description: '按方案 A 实现并提交验收',
    routing: { mode: 'node', groupId: LF_GROUP, targetNodeId: WORKER_NODE },
  };
  const res = await submitRoutedTask(input, dispatchPorts());
  expect(res.dispatched).toBe(true);
  expect(res.nodeId).toBe(WORKER_NODE);

  const out = getTask(res.task.id)!;
  expect(out.delegationId).not.toBeNull();
  const dl = out.delegationId!;

  // worker 承接行（task.assigned 到达 worker——delegation-sync 域，直种同形行：
  // classic lf 承接戳 delegation_role='in'，路由不复刻（判向单看 role））
  const workerRow = insertTask({
    workspaceId: 'ws1',
    title: '承接任务',
    creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1',
    status: 'assigned',
    executionSessionId: workerExecSessionId,
    delegationId: dl,
  });
  updateTask(workerRow.id, { delegationRole: 'in' });
  return { out: getTask(out.id)!, worker: getTask(workerRow.id)!, dl };
}

/**
 * lf 全链前置（场景 1/2 共用）：dispatch 戳 out（twoPhase）→ worker 请求落行
 * → S2 桥 intervene → S5 镜像 → 发起方面板 → 代答 → S3 消费 → 提交 →
 * S5 submitted 镜像。逐段断言（编号对应 spec §8 时序步）。
 */
async function lfThroughSubmitted(): Promise<{
  out: TaskRow; worker: TaskRow; dl: string; originSessionId: string; iv1: string;
}> {
  const { out, worker, dl } = await seedLfDispatch();

  // ① dispatch 戳 out（twoPhase）：双端 ≥1.11 → 两段式行戳（不设 auto_accept）
  expect(out.delegationRole).toBe('out');
  expect(out.autoAccept).toBe(false);
  expect(out.routing).toEqual({ mode: 'node', groupId: LF_GROUP, targetNodeId: WORKER_NODE });
  // S6 跟踪会话随派发创建（外派行执行会话落点）
  expect(out.executionSessionId).not.toBeNull();
  expect(getSession(out.executionSessionId!)?.kind).toBe('task_execution');
  const originSessionId = out.executionSessionId!;

  seedSessionLeader(workerExecSessionId);
  const run = startRun(worker.id, { trigger: 'initial', executionSessionId: workerExecSessionId });
  expect(run.runNo).toBe(1);

  // ② worker 侧 request_human 落行 → ③ S2 桥 task.intervene（载荷逐字段）
  const req = requestHuman({
    sessionId: workerExecSessionId,
    kind: 'question',
    title: '确认实现方案',
    prompt: '选 A 还是 B？',
    taskId: worker.id,
    runId: getActiveRun(worker.id)!.id,
    optionsJson: JSON.stringify([
      { id: 'a', label: '方案A' },
      { id: 'b', label: '方案B', description: '保守' },
    ]),
    payloadJson: JSON.stringify({ context: { stage: 2 } }),
    deadlineMinutes: 30,
  });
  expect(getTask(worker.id)?.status).toBe('waiting_human');
  await flushAsync();
  expect(rpcCalls(TASK_RPC.intervene)).toEqual([
    {
      taskId: dl,
      intervention: {
        interventionId: req.id,
        runNo: 1,
        kind: 'question',
        title: '确认实现方案',
        prompt: '选 A 还是 B？',
        payload: { context: { stage: 2 } },
        options: [
          { id: 'a', label: '方案A' },
          { id: 'b', label: '方案B', description: '保守' },
        ],
        deadlineAt: req.deadlineAt,
      },
    },
  ]);

  // ④ 模拟 hub 定向 task.intervention → 发起方 S5 镜像行落
  await handleTaskInterventionMirror(sim.interventionEvent(req.id));
  const mirror = findRemoteMirrorRequest(WORKER_NODE, req.id);
  expect(mirror).not.toBeNull();
  expect(mirror!.taskId).toBe(out.id);
  expect(mirror!.sessionId).toBe(originSessionId);
  expect(mirror!.status).toBe('pending');
  expect(milestoneRows().some((m) => m.meta['kind'] === 'remote_intervention')).toBe(true);

  // ⑤ 发起方面板数据就位（human:list 投影链路）
  const panel = projectHumanListRows(listRequests({ sessionId: originSessionId }));
  const panelRow = panel.find((r) => r.remoteId === req.id);
  expect(panelRow).toBeDefined();
  expect(panelRow!.status).toBe('pending');
  expect(panelRow!.originNodeName).toBe(WORKER_NODE_NAME);

  // ⑥ 发起方 answer → S6 路由 task.answer（载荷断言）→ ⑦ 模拟 hub
  //    interventionAnswered → worker S3 消费（注入 + 唤醒）
  const answerRes = await answerHumanRouted(mirror!.id, { selected: ['a'] }, '补充说明');
  expect(answerRes).toEqual({ disposition: 'answered' });
  expect(rpcCalls(TASK_RPC.answer)).toEqual([
    {
      taskId: dl,
      decision: 'approve',
      interventionId: req.id,
      answer: { text: '补充说明', selected: ['a'] },
    },
  ]);
  expect(getHumanRequest(mirror!.id)!.status).toBe('answered');

  handleInterventionAnswered(sim.interventionAnsweredEvent(req.id));
  const workerReq = getHumanRequest(req.id)!;
  expect(workerReq.status).toBe('answered');
  expect(workerReq.answeredByNodeId).toBe(`remote:${SELF_NODE}`);
  expect(JSON.parse(workerReq.answerJson!)).toEqual({ text: '补充说明', selected: ['a'] });
  expect(getTask(worker.id)!.status).toBe('in_progress'); // 等人体恢复
  const sys = systemRows(workerExecSessionId);
  expect(sys).toHaveLength(1);
  expect(sys[0]!.event_type).toBe('human_answer');
  expect(sys[0]!.body.startsWith('【人工答复】')).toBe(true);
  expect(routeUserChatMock).toHaveBeenCalledTimes(1);
  expect(routeUserChatMock).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: workerExecSessionId, systemKickoff: true }),
  );

  // ⑧ worker submitRun → S2 桥 report submitted（载荷断言）
  await submitRun(worker.id, { summary: '交付完成', files: ['a.ts'] });
  await flushAsync();
  expect(sim.sendResMock).toHaveBeenCalledTimes(1);
  expect(sim.sendResMock.mock.calls[0]!.slice(0, 2)).toEqual([dl, TASK_WIRE.report]);
  expect(sim.sendResMock.mock.calls[0]![2]).toEqual({
    status: 'submitted',
    runNo: 1,
    reason: JSON.stringify({ summary: '交付完成', files: ['a.ts'], artifacts: [] }),
  });
  expect(getTask(worker.id)!.status).toBe('submitted');

  // ⑨ 模拟 hub 定向 task.submitted → 发起方 S5 镜像 + acceptance 行
  await handleTaskSubmittedMirror(sim.submittedEvent());
  const outAfter = getTask(out.id)!;
  expect(outAfter.status).toBe('submitted');
  expect(outAfter.submittedAt).not.toBeNull();
  const acceptance = findRemoteMirrorRequest(WORKER_NODE, `${dl}#1`);
  expect(acceptance).not.toBeNull();
  expect(acceptance!.kind).toBe('acceptance');
  expect(acceptance!.status).toBe('pending');
  expect(JSON.parse(acceptance!.payloadJson!).acceptance).toEqual({
    runNo: 1,
    summary: '交付完成',
    files: ['a.ts'],
    artifacts: [],
  });
  expect(milestoneRows().some((m) => m.meta['kind'] === 'remote_submitted' && m.meta['runNo'] === 1)).toBe(true);

  return {
    out: getTask(out.id)!, worker: getTask(worker.id)!, dl, originSessionId, iv1: req.id,
  };
}

/** S4 消费端口（settleDocked spy——停靠出清调用面断言） */
function consumePorts(): { ports: WorkerTerminalConsumePorts; settleDocked: ReturnType<typeof vi.fn> } {
  const settleDocked = vi.fn();
  return {
    ports: {
      selfNodeId: () => SELF_NODE,
      settleDocked: (taskId: string, outcome: 'accepted' | 'rejected') => settleDocked(taskId, outcome),
    },
    settleDocked,
  };
}

/** S4 消费端口（worker 角色面——SimHub 账本 targetNodeId 投影 WORKER_NODE，
 *  阶段 1.5 全量过滤按 worker 自证；单进程双角色约定的 worker 侧变体） */
function workerConsumePorts(): { ports: WorkerTerminalConsumePorts; settleDocked: ReturnType<typeof vi.fn> } {
  const settleDocked = vi.fn();
  return {
    ports: {
      selfNodeId: () => WORKER_NODE,
      settleDocked: (taskId: string, outcome: 'accepted' | 'rejected') => settleDocked(taskId, outcome),
    },
    settleDocked,
  };
}

// ── 场景 1（lf 全链）─────────────────────────────────────────────────────────

describe('场景 1（lf 全链）：intervene → 代答 → 提交 → 验收 → 双侧 completed', () => {
  it('spec §8 双向时序全链（dispatch 戳 out twoPhase → S4 终态一致）', async () => {
    const { out, worker, dl } = await lfThroughSubmitted();

    // ⑩ 发起方 accept → S6 先本地后远端（task.accept 载荷断言）
    const acceptRes = await acceptTaskRouted(out.id);
    expect(acceptRes.status).toBe('completed');
    expect(acceptRes.remoteWarning).toBeUndefined();
    const outAccepted = getTask(out.id)!;
    expect(outAccepted.status).toBe('completed');
    expect(outAccepted.acceptedAt).not.toBeNull();
    expect(terminalCalls).toEqual([
      { delegationId: dl, outcome: 'accepted', statusAtCall: 'completed' }, // 顺序锁：转发时本地已 completed
    ]);
    expect(rpcCalls(TASK_RPC.accept)).toEqual([{ taskId: dl }]);

    // ⑪ 模拟 hub 定向 task.accepted → worker S4 消费（任务终态）
    const { ports, settleDocked } = consumePorts();
    await handleTaskAccepted(sim.acceptedEvent(), ports);
    const workerDone = getTask(worker.id)!;
    expect(workerDone.status).toBe('completed');
    expect(workerDone.acceptedAt).not.toBeNull();
    expect(listRuns(worker.id).map((r) => r.status)).toEqual(['accepted']);
    const workerAcceptance = listByTask(worker.id).find((r) => r.kind === 'acceptance')!;
    expect(workerAcceptance.status).toBe('answered');
    expect(workerAcceptance.answeredByNodeId).toBe('remote:origin');
    expect(settleDocked).toHaveBeenCalledWith(dl, 'accepted');
    expect(milestoneRows().some((m) => m.meta['kind'] === 'accepted' && m.task_id === worker.id)).toBe(true);

    // ⑫ 终局断言块：双侧终态一致 + 关键 RPC 计数
    expect(getTask(out.id)!.status).toBe('completed');
    expect(getTask(worker.id)!.status).toBe('completed');
    expect(rpcCalls(TASK_RPC.intervene)).toHaveLength(1);
    expect(rpcCalls(TASK_RPC.answer)).toHaveLength(1);
    expect(rpcCalls(TASK_RPC.accept)).toHaveLength(1);
    expect(sim.sendResMock).toHaveBeenCalledTimes(1);
  });
});

// ── 场景 2（reject 返工）─────────────────────────────────────────────────────

describe('场景 2（reject 返工）：打回 → run#2 再提交 → accept（hub runNo 语义）', () => {
  it('task.reject 载荷 + worker 返工 + 事件 runNo=2 透传', async () => {
    const { out, worker, dl } = await lfThroughSubmitted();

    // ⑩' 发起方 reject（reason 透传）→ 本地回 assigned（返工排队）
    const rejectRes = await rejectTaskRouted(out.id, '缺少回归测试');
    expect(rejectRes.status).toBe('assigned');
    expect(terminalCalls).toEqual([
      { delegationId: dl, outcome: 'rejected', reason: '缺少回归测试', statusAtCall: 'assigned' },
    ]);
    expect(rpcCalls(TASK_RPC.reject)).toEqual([{ taskId: dl, reason: '缺少回归测试' }]);
    // 首轮 acceptance 镜像行随打回答复（reject 决策留痕）
    const acc1 = findRemoteMirrorRequest(WORKER_NODE, `${dl}#1`)!;
    expect(acc1.status).toBe('answered');
    expect(JSON.parse(acc1.answerJson!)).toEqual({ decision: 'reject', reason: '缺少回归测试' });

    // ⑪' 模拟 hub 定向 task.rejected（hub 账本 run_no+1 → 事件 runNo=2）
    const { ports, settleDocked } = consumePorts();
    await handleTaskRejected(sim.rejectedEvent('缺少回归测试'), ports);
    expect(sim.rejectedEvent('缺少回归测试')).toEqual({ taskId: dl, runNo: 2, reason: '缺少回归测试' });
    const workerAfterReject = getTask(worker.id)!;
    expect(workerAfterReject.status).toBe('assigned'); // 返工排队
    expect(listRuns(worker.id).map((r) => r.status)).toEqual(['rejected']);
    expect(listRuns(worker.id)[0]!.rejectReason).toBe('缺少回归测试');
    expect(settleDocked).toHaveBeenCalledWith(dl, 'rejected');
    expect(milestoneRows().some((m) => m.meta['kind'] === 'rejected' && m.meta['runNo'] === 2)).toBe(true);

    // ⑫' worker 返工：run#2 再执行再提交（report runNo=2）
    const run2 = startRun(worker.id, { trigger: 'rework', executionSessionId: workerExecSessionId });
    expect(run2.runNo).toBe(2);
    await submitRun(worker.id, { summary: '返工交付（含回归测试）' });
    await flushAsync();
    expect(sim.sendResMock).toHaveBeenCalledTimes(2);
    expect(sim.sendResMock.mock.calls[1]![2]).toEqual({
      status: 'submitted',
      runNo: 2,
      reason: JSON.stringify({ summary: '返工交付（含回归测试）', files: [], artifacts: [] }),
    });

    // ⑬' 模拟 hub 定向 task.submitted（runNo=2 透传 → 镜像幂等键 `dl#2`）
    await handleTaskSubmittedMirror(sim.submittedEvent());
    expect(sim.submittedEvent()).toEqual({
      taskId: dl, runNo: 2, deliverable: { summary: '返工交付（含回归测试）', files: [], artifacts: [] },
    });
    const outResub = getTask(out.id)!;
    expect(outResub.status).toBe('submitted');
    const acc2 = findRemoteMirrorRequest(WORKER_NODE, `${dl}#2`)!;
    expect(acc2).not.toBeNull();
    expect(JSON.parse(acc2.payloadJson!).acceptance.runNo).toBe(2);
    // 发起方 run 账目：首轮 run 已 rejected（终态）→ 二轮 run 懒建锚 runNo=2
    expect(getActiveRun(out.id)!.runNo).toBe(2);
    expect(milestoneRows().some((m) => m.meta['kind'] === 'remote_submitted' && m.meta['runNo'] === 2)).toBe(true);

    // ⑭' 发起方 accept（二轮）→ task.accept → ⑮' 模拟 task.accepted（runNo=2）
    const acceptRes = await acceptTaskRouted(out.id);
    expect(acceptRes.status).toBe('completed');
    expect(rpcCalls(TASK_RPC.accept)).toEqual([{ taskId: dl }]);
    expect(sim.acceptedEvent()).toEqual({ taskId: dl, runNo: 2 });
    await handleTaskAccepted(sim.acceptedEvent(), ports);

    // 终局断言块：双侧 completed + run 历史（rejected → accepted）+ 计数
    expect(getTask(worker.id)!.status).toBe('completed');
    expect(getTask(out.id)!.status).toBe('completed');
    expect(getTask(out.id)!.acceptedAt).not.toBeNull();
    expect(listRuns(worker.id).map((r) => [r.runNo, r.status])).toEqual([[1, 'rejected'], [2, 'accepted']]);
    // 发起方两轮 acceptance 镜像行各一（幂等键 dl#1 / dl#2）
    expect(findRemoteMirrorRequest(WORKER_NODE, `${dl}#1`)!.status).toBe('answered');
    expect(findRemoteMirrorRequest(WORKER_NODE, `${dl}#2`)!.status).toBe('answered');
    expect(rpcCalls(TASK_RPC.intervene)).toHaveLength(1); // 返工轮无新干预
    expect(sim.sendResMock).toHaveBeenCalledTimes(2); // runNo 1 + 2
  });
});

// ── 场景 3（peer 全链）───────────────────────────────────────────────────────

describe('场景 3（peer 全链）：draft 派发 → 镜像行拒答 → 本地自答 → peer 验收权', () => {
  it('peer 人话拒答 + worker 本地闭环 + 发起方 accept 允许（peer 验收权）', async () => {
    // ① dispatch peer_draft（draft 载荷白名单形状：无 permissionTier 等编排键）
    const res = await submitRoutedTask(
      {
        workspaceId: 'ws1',
        workspaceName: 'Test',
        title: '请帮忙排查线上告警',
        description: '告警详见附件',
        routing: { mode: 'node', groupId: PEER_GROUP, targetNodeId: WORKER_NODE },
        draft: true,
        priority: 5,
      },
      dispatchPorts(),
    );
    expect(res.dispatched).toBe(true);
    const out = getTask(res.task.id)!;
    const dl = out.delegationId!;
    expect(out.origin).toBe('peer_draft');
    expect(out.delegationRole).toBe('out');
    expect(rpcCalls(TASK_RPC.delegate)).toEqual([
      {
        groupId: PEER_GROUP,
        targetNodeId: WORKER_NODE,
        workspaceName: 'Test',
        task: { title: '请帮忙排查线上告警', prompt: '告警详见附件', draft: true, priority: 5 },
      },
    ]);

    // ② worker peer 承接行（peer-draft 承接形：role NULL + routing 指向本机）
    const workerRow = insertTask({
      workspaceId: 'ws1',
      title: '承接草稿',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-1',
      status: 'assigned',
      executionSessionId: workerExecSessionId,
      delegationId: dl,
      routing: { mode: 'node', groupId: PEER_GROUP, targetNodeId: SELF_NODE },
    });
    seedSessionLeader(workerExecSessionId);
    startRun(workerRow.id, { trigger: 'initial', executionSessionId: workerExecSessionId });

    // ③ worker intervene（S2 桥载荷断言——peer 承接行按路由判向）
    const req = requestHuman({
      sessionId: workerExecSessionId,
      kind: 'question',
      title: '口径确认',
      prompt: '只排查还是顺手修？',
      taskId: workerRow.id,
      runId: getActiveRun(workerRow.id)!.id,
    });
    await flushAsync();
    expect(rpcCalls(TASK_RPC.intervene)).toEqual([
      {
        taskId: dl,
        intervention: {
          interventionId: req.id,
          runNo: 1,
          kind: 'question',
          title: '口径确认',
          prompt: '只排查还是顺手修？',
        },
      },
    ]);

    // ④ 发起方 answer 镜像行到达（peer 组 hub 不转发事件——经 S7 对账拉取等价
    //    到达；S5 镜像无组判别，拒答防线在 S6 主进程层）
    await handleTaskInterventionMirror(sim.interventionEvent(req.id));
    const mirror = findRemoteMirrorRequest(WORKER_NODE, req.id)!;
    expect(mirror).not.toBeNull();
    expect(mirror.status).toBe('pending');
    // 面板投影：peer 镜像行带 peerMirror 标记
    const panelRow = projectHumanListRows(
      listRequests({ sessionId: out.executionSessionId! }),
    ).find((r) => r.remoteId === req.id);
    expect(panelRow!.peerMirror).toBe(true);

    // ⑤ 发起方代答 → 主进程拒绝（peer 人话断言）+ 零 task.answer RPC
    await expect(answerHumanRouted(mirror.id, { text: '先只排查' })).rejects.toThrow(
      '平行组不转发人工请求，请在执行节点处理',
    );
    expect(rpcCalls(TASK_RPC.answer)).toHaveLength(0);
    expect(getHumanRequest(mirror.id)!.status).toBe('pending'); // 行保持 pending

    // ⑥ worker 本地自答（节点所有者在请求面板处理——peer 语义）
    const local = answerHuman(req.id, { text: '本地定了：只排查' }, 'local');
    expect(local).toEqual({ disposition: 'answered' });
    expect(getHumanRequest(req.id)!.answeredByNodeId).toBe('local');
    expect(getTask(workerRow.id)!.status).toBe('in_progress');

    // ⑦ worker 提交 → report submitted
    await submitRun(workerRow.id, { summary: '排查结论：连接池泄漏' });
    await flushAsync();
    expect(sim.sendResMock).toHaveBeenCalledTimes(1);
    expect(sim.sendResMock.mock.calls[0]!.slice(0, 2)).toEqual([dl, TASK_WIRE.report]);

    // ⑧ 模拟 task.submitted → 发起方 acceptance 镜像行
    await handleTaskSubmittedMirror(sim.submittedEvent());
    const acceptance = findRemoteMirrorRequest(WORKER_NODE, `${dl}#1`)!;
    expect(acceptance).not.toBeNull();
    expect(getTask(out.id)!.status).toBe('submitted');

    // ⑨ 发起方 acceptance（S6 accept 允许——peer 验收权）→ ⑩ worker 终态
    const acceptRes = await acceptTaskRouted(out.id);
    expect(acceptRes.status).toBe('completed');
    expect(rpcCalls(TASK_RPC.accept)).toEqual([{ taskId: dl }]);
    const { ports, settleDocked } = consumePorts();
    await handleTaskAccepted(sim.acceptedEvent(), ports);
    expect(settleDocked).toHaveBeenCalledWith(dl, 'accepted');

    // 终局断言块：双侧 completed；peer 镜像问题行在发起方恒 pending（设计语义）
    expect(getTask(workerRow.id)!.status).toBe('completed');
    expect(getTask(out.id)!.status).toBe('completed');
    expect(getHumanRequest(mirror.id)!.status).toBe('pending');
    expect(rpcCalls(TASK_RPC.answer)).toHaveLength(0); // 全程零代答转发
    expect(sim.sendResMock).toHaveBeenCalledTimes(1);
  });
});

// ── 场景 4（断线重连对账）────────────────────────────────────────────────────

describe('场景 4（断线重连）：离线降级 + S7 对账收敛 + 幂等计数', () => {
  it('断线窗口降级/自答 → 重连对账补应用/镜像收敛 → 提交补收 → accept → 双侧终态', async () => {
    // ① 在线链至 intervene 送达 + 发起方镜像行落（发起方未代答）
    const { out, worker, dl } = await seedLfDispatch();
    seedSessionLeader(workerExecSessionId);
    startRun(worker.id, { trigger: 'initial', executionSessionId: workerExecSessionId });
    const req1 = requestHuman({
      sessionId: workerExecSessionId,
      kind: 'question',
      title: '确认方案',
      prompt: 'A 还是 B？',
      taskId: worker.id,
      runId: getActiveRun(worker.id)!.id,
    });
    await flushAsync();
    expect(rpcCalls(TASK_RPC.intervene)).toHaveLength(1);
    await handleTaskInterventionMirror(sim.interventionEvent(req1.id));
    const mirror1 = findRemoteMirrorRequest(WORKER_NODE, req1.id)!;
    expect(mirror1.status).toBe('pending');
    expect(milestoneCount()).toBe(1); // remote_intervention

    // ② 断线（client 状态切离线）
    sim.online = false;

    // ③ 断线窗口：worker 新请求 → S2 桥降级（intervene_degraded 里程碑 + 本地等待）
    const req2 = requestHuman({
      sessionId: workerExecSessionId,
      kind: 'manual_action',
      title: '请重启本地服务',
      prompt: '重启后点完成',
      taskId: worker.id,
      runId: getActiveRun(worker.id)!.id,
    });
    await flushAsync();
    expect(rpcCalls(TASK_RPC.intervene)).toHaveLength(1); // 零新增 RPC 尝试
    expect(getHumanRequest(req2.id)!.status).toBe('pending'); // 本地等待降级
    const degraded = milestoneRows().find((m) => m.meta['kind'] === 'intervene_degraded')!;
    expect(degraded).toBeDefined();
    expect(degraded.body).toContain('干预上报降级');
    expect(degraded.meta['reason']).toBe('hub 离线');
    expect(milestoneCount()).toBe(2);

    // ④ worker 自答（节点所有者本地面板处理 #2）
    expect(answerHuman(req2.id, { completed: true }, 'local')).toEqual({ disposition: 'answered' });
    expect(getTask(worker.id)!.status).toBe('in_progress');
    expect(routeUserChatMock).toHaveBeenCalledTimes(1); // 本地自答注入唤醒

    // ⑤ 发起方远端代答 #1（发起方节点自有连接——SimHub 直调代表；worker 错过回执）
    sim.applyAnswer(dl, req1.id, { selected: ['A'], text: '远端选 A' }, SELF_NODE);
    expect(getHumanRequest(req1.id)!.status).toBe('pending'); // 回执未达，本地仍 pending

    // ⑥ 重连 → S7 对账 #1：worker 补应用代答 + 发起方镜像收敛
    sim.online = true;
    await reconcileOnReconnect({ client: sim.client(), consumePorts: consumePorts().ports });
    const req1After = getHumanRequest(req1.id)!;
    expect(req1After.status).toBe('answered');
    expect(req1After.answeredByNodeId).toBe(`remote:${SELF_NODE}`);
    expect(JSON.parse(req1After.answerJson!)).toEqual({ selected: ['A'], text: '远端选 A' });
    expect(systemRows(workerExecSessionId).filter((r) => r.event_type === 'human_answer')).toHaveLength(2); // #2 自答 + #1 对账补注入
    expect(routeUserChatMock).toHaveBeenCalledTimes(2);
    const mirror1After = getHumanRequest(mirror1.id)!;
    expect(mirror1After.status).toBe('answered'); // 发起方镜像收敛（tryAnswer，不注入不唤醒）
    expect(mirror1After.answeredByNodeId).toBe(`remote:${SELF_NODE}`);
    expect(milestoneCount()).toBe(2); // 对账零新增里程碑

    // ⑦ worker 提交（在线；未决请求已清）→ report submitted
    await submitRun(worker.id, { summary: '断线重连后的交付' });
    await flushAsync();
    expect(sim.sendResMock).toHaveBeenCalledTimes(1);
    expect(getTask(worker.id)!.status).toBe('submitted');
    // 发起方错过 task.submitted 事件（断线窗口语义）→ 本地仍 pending

    // ⑧ S7 对账 #2：task.list submitted 补收 → 发起方镜像 + acceptance 落
    //   （worker 角色面 ports——阶段 1.5 见 hub submitted runNo==本地 → 在途正常 no-op）
    await reconcileOnReconnect({ client: sim.client(), consumePorts: workerConsumePorts().ports });
    expect(getTask(out.id)!.status).toBe('submitted');
    const acceptance = findRemoteMirrorRequest(WORKER_NODE, `${dl}#1`)!;
    expect(acceptance).not.toBeNull();
    expect(acceptance.kind).toBe('acceptance');
    expect(milestoneCount()).toBe(3); // + remote_submitted

    // ⑨ 幂等计数断言：同快照三次对账零重复（里程碑/行数/RPC 计数）
    const milestoneSnap = milestoneCount();
    const humanSnap = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM human_requests`).get() as { n: number }
    ).n;
    const acceptanceSnap = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM human_requests WHERE kind = 'acceptance'`).get() as { n: number }
    ).n;
    const requestSnap = sim.requestMock.mock.calls.length;
    const sendResSnap = sim.sendResMock.mock.calls.length;
    await reconcileOnReconnect({ client: sim.client(), consumePorts: workerConsumePorts().ports });
    expect(milestoneCount()).toBe(milestoneSnap);
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM human_requests`).get() as { n: number }).n).toBe(humanSnap);
    expect(
      (getDb().prepare(`SELECT COUNT(*) AS n FROM human_requests WHERE kind = 'acceptance'`).get() as { n: number }).n,
    ).toBe(acceptanceSnap);
    // 仅对账拉取（interventions×2 + list×2——阶段 3 submitted 补收 + 阶段 1.5
    // worker 终态全量），零业务 RPC
    expect(sim.requestMock.mock.calls.length).toBe(requestSnap + 4);
    expect(sim.sendResMock.mock.calls.length).toBe(sendResSnap);

    // ⑩ 发起方 accept → 模拟 task.accepted → worker 终态
    const acceptRes = await acceptTaskRouted(out.id);
    expect(acceptRes.status).toBe('completed');
    expect(terminalCalls).toEqual([
      { delegationId: dl, outcome: 'accepted', statusAtCall: 'completed' },
    ]);
    const { ports, settleDocked } = consumePorts();
    await handleTaskAccepted(sim.acceptedEvent(), ports);
    expect(settleDocked).toHaveBeenCalledWith(dl, 'accepted');

    // 终局断言块：双侧终态一致 + 全程计数
    expect(getTask(worker.id)!.status).toBe('completed');
    expect(getTask(worker.id)!.acceptedAt).not.toBeNull();
    expect(getTask(out.id)!.status).toBe('completed');
    expect(getTask(out.id)!.acceptedAt).not.toBeNull();
    expect(rpcCalls(TASK_RPC.intervene)).toHaveLength(1); // #1 送达 ×1，#2 降级零尝试
    expect(rpcCalls(TASK_RPC.accept)).toHaveLength(1);
    expect(sim.sendResMock).toHaveBeenCalledTimes(1); // 提交仅在线一次
  });

  it('worker-miss 变体：accept 发生在断线窗口 → 重连 S7 阶段 1.5 收口 worker 终态', async () => {
    // ① 在线链至 worker 提交（hub 账本 submitted runNo=1；发起方镜像未落——不在本变体断言面）
    const { worker, dl } = await seedLfDispatch();
    seedSessionLeader(workerExecSessionId);
    startRun(worker.id, { trigger: 'initial', executionSessionId: workerExecSessionId });
    await submitRun(worker.id, { summary: 'worker-miss 交付' });
    await flushAsync();
    expect(sim.sendResMock).toHaveBeenCalledTimes(1);
    expect(getTask(worker.id)!.status).toBe('submitted');

    // ② 断线：worker 错过 task.accepted 事件窗口
    sim.online = false;

    // ③ 断线窗口内发起方验收（发起方节点自有连接——账本直改代表；事件未达 worker）
    sim.applyAccept(dl);
    expect(getTask(worker.id)!.status).toBe('submitted'); // 回执未达，本地仍 submitted

    // ④ 重连 → S7 阶段 1.5：hub done → handleTaskAccepted 复用路径收口
    //   （worker 角色面 ports——hub 投影 targetNodeId=WORKER_NODE，按 worker 自证过滤）
    sim.online = true;
    const { ports, settleDocked } = workerConsumePorts();
    await reconcileOnReconnect({ client: sim.client(), consumePorts: ports });
    const done = getTask(worker.id)!;
    expect(done.status).toBe('completed');
    expect(done.acceptedAt).not.toBeNull();
    expect(listRuns(worker.id).map((r) => r.status)).toEqual(['accepted']);
    expect(settleDocked).toHaveBeenCalledWith(dl, 'accepted');
    expect(milestoneRows().some((m) => m.meta['kind'] === 'accepted' && m.task_id === worker.id)).toBe(true);

    // ⑤ 幂等：二次对账零重复（计数级——里程碑/run 行/settleDocked 均不变）
    const ms = milestoneCount();
    const runs = listRuns(worker.id).length;
    await reconcileOnReconnect({ client: sim.client(), consumePorts: ports });
    expect(milestoneCount()).toBe(ms);
    expect(listRuns(worker.id)).toHaveLength(runs);
    expect(settleDocked).toHaveBeenCalledTimes(1);
  });
});

// ── S9 残留：hub:taskList 1.11 投影字段原样透传 ──────────────────────────────

describe('S9 残留：hub:taskList handler 直调——runNo/submittedAt/acceptedAt 透传', () => {
  it('coded 包装原样返回 hub 响应（零投影改写）+ RPC 方法名/载荷', async () => {
    const record: Record<string, unknown> = {
      taskId: 'dl-s9',
      workspaceName: 'Test',
      targetNodeId: WORKER_NODE,
      groupId: LF_GROUP,
      status: 'submitted',
      title: '投影链路任务',
      createdAt: 1893456000000,
      updatedAt: 1893456100000,
      runNo: 2,
      submittedAt: 1893456050000,
    };
    simhubShared.taskListResponse = { tasks: [record] };
    registerHubIpc();
    const handler = simhubShared.ipcHandlers.get('hub:taskList')!;
    const res = (await handler(undefined, undefined)) as { tasks: Array<Record<string, unknown>> };
    // 原样透传：1.11 投影字段全保留（S9 A3 声明的零改写证据）
    expect(res).toEqual({ tasks: [record] });
    expect(res.tasks[0]!.runNo).toBe(2);
    expect(res.tasks[0]!.submittedAt).toBe(1893456050000);
    expect(res.tasks[0]!.acceptedAt).toBeUndefined(); // 未验收不带键（协议缺省形状同样可达）
    // RPC 边界：方法名 + 空载荷（groupId 缺省不带键）
    const { hubRequest } = await import('../../src/main/hub/index');
    expect(vi.mocked(hubRequest)).toHaveBeenCalledWith('task.list', {}, undefined);
  });
});
