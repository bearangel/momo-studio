// tests/e2e/hub-distribution.spec.ts
//
// M2.3 Task 7（P3-4）——hub 分发链 / readonly 即时拒 / 版本链 回归沉淀 e2e。
//
// 被测链路（六场景）：
//   1. 发布→记账：custom skill 经资源库「发布到 hub」→ hub multipart 收包 →
//      installed_packages 落 `hub:{slug}` 发布记账（M5.2 起记账≠已装：库页零
//      hub 卡，仅 custom 本体卡「已发布」徽标——用户实测双卡回归锁）
//   2. manifest 携带：镜像向导 S2 构建+上传 → 快照 manifest.resources 携带已发布
//      skill（记账反查，UC-P1-3 分发闭环裁定）→ S2「Skill 清单（补装 + 内嵌）」
//      计数 1 补装 + 0 内嵌
//   3. 全新 profile 零 unresolved：隔离 userData 的第二实例收 mirror.apply →
//      先装后落（installResources 补装 skill）→ 回执 appliedResources 含
//      skill/{slug} 且 unresolvedRefs 无任何 skill:* 条目
//   4. readonly 即时拒：task.assigned{permissionTier:'readonly'} → mock LLM 驱动
//      bash 写工作空间外 → seatbelt 拦截 → write-blocked 漏斗即时 denied
//      （task.report 进度拍 kind='denied'，excerpt 含「只读档位即时拒绝」）
//   5. 版本链 v1→v2 前进：目录 latest（hub v0.1.5 = versions semver max）→
//      resource.published 事件驱动「可更新」角标 → 更新走 fresh 目录 → v2 下载
//      安装记账（T2 语义：compareVersions 前进才装）
//   6. 已是最新如实报：同版再装 → installHubPackage 返回 alreadyLatest:true
//      零动作（无第二次下载——不谎报已更新）
//
// M4.0 T3 追加（spec 2026-10-29 §2.2——HITL 远程代答 e2e 沉淀，场景7/8）：
//   7. 代答主链：A（leader）建组委派 B → B 真实收派（task.assigned → 委派会话
//      建立回合启动，mock LLM hold 剧本保持 running 无终态）→ A 卡等待角标 →
//      「批准节点写入」两段确认 → toast 已远程批准 + hub 收 task.answer 对账 +
//      task.answered 事件回卡留痕（门控链：hubProtoVer 1.5.0 + waiting + leader 视角）
//   8. 版本门控负例：低版本节点（hello 回 1.2.0，major 同可连接）同构 waiting 卡
//      → 右键菜单无代答项（hubSupportsMinor(ver,3) false——版本过低菜单不出现）
//
// M5.0 X2 追加（spec 2026-10-30 §7——资源归属 studio 从票，场景9）：
//   9. 归属全链：A 发布认领 → B 同 slug 发布（直连 API）403 not_owner 人话 +
//      B custom 卡发布钮收敛不渲染 → A 原主新版 v1.1.0 → A 卡「已发布」徽标 →
//      A 获取弹窗 own 行免装（你的发布 · 本地 v · 已发布 v）→ B 安装被
//      源头拦截（本地同名自定义实体 → 拒装人话，零下载）。mock hub 目录/事件
//      携 ownerNodeId，/resources/publish 实装领地判定（他节点 403 携 owner_name）。
//
// M5.1 追加（spec 2026-10-30 §1——插件×本地副本去重 + 发布版本回写）：
//   10.（并入场1）发布回写：发布 v1.0.1 → 本地 custom skill 行 version=hub 发布
//      版本（SKILL.md frontmatter 回写，spec §1.2）
//   11. 导入拦截：dev 插件提供技能 → zip 导入同名 → 拒 + 人话（spec §1.3）
//   12. 提示条→清理：custom 副本 → Skill 页「检测到 1 个」提示条 → 一键清理 →
//      提示条消失 + custom 卡不输出（归并隐藏）+ 插件卡保留（spec §1.1）
//
// T3 mock 边界（如实记录——真实链背书 = M3.1 真机验收 + tests/hub 单测）：
//   ① waiting 拍合成：真实产生点 = worker runner L1b（sessionWaiting 检测写授权
//      等待登记后自发 task.report kind='waiting-input'，hub 转发 leader）——e2e
//      由 mock hub 直接向 leader 合成该事件；runner 等待语义锁在
//      tests/hub/delegation-runner.test.ts。e2e 锁的是 leader 侧消费链
//      （事件桥 → delegation-sync kv → renderer 门控 → 菜单 → task.answer →
//      toast → answered 留痕）与 worker 侧真实收派前半链。
//   ② workspace.mirrored 合成：真实链 = 镜像向导上传 + mirror.apply 回执（本文件
//      场景2/3 已锁）；场景7/8 只为 RunRoutingField 预检门与 pickWorker mirroredBy
//      候选最小造数，B 的同名工作空间为场景3 mirror.apply 真实产物。
//   ③ task.answer 恒回 granted：worker 侧真实应答（granted/denied/stale 按未决
//      登记裁决）锁在 tests/hub/delegation-answer.test.ts——mock 只模拟 hub 契约
//      形状（回执 + task.answered 事件）。
//   ④ 进度拍只转发首拍：真实 hub 持续转发 worker 上报；mock 抑制后续拍，防 B 侧
//      hold 剧本零星增量拍冲掉合成 waiting 态（等待→代答链不依赖后续拍）。
//
// 环境（零外网零 sibling 仓——studio 消费端点逐一 mock，单端口）：
//   - mock hub（node:http + ws）：
//       POST /enroll                              → {nodeId, deviceToken}
//       WS   /ws                                  → hello/ping/group.*/task.* RPC 应答
//                                                 + resource.published/task.assigned 下发
//                                                 + mirror.apply 定向 req（收 mirror.receipt res）
//                                                 + task.report res 捕获（id=taskId）
//       GET  /resources/catalog                   → HubCatalog（latest=semver max、versions 降序、
//                                                 M5.0 条目携 ownerNodeId）
//       POST /resources/publish                   → multipart(manifest+package) 收包即记 201；
//                                                 M5.0 领地判定——他节点领地 403 not_owner 携 owner_name
//       GET  /resources/{slug}/{version}/download → 归档字节（计数按 slug@version）
//       POST /workspaces/snapshots                → multipart(manifest+payload) 201
//       GET  /workspaces/snapshots/{id}/download  → payload + X-Checksum-Sha256
//   - mock LLM：POST /v1/chat/completions——OpenAI 兼容；stream:true 走 SSE
//     （可编排 tool_calls/final），非流式返回 JSON（会话命名等杂项调用）。
//     provider 行 baseUrl 指向本服务（llm-provider 既有缝——产品侧零改动）。
//
// 运行（同既有 e2e 惯例，需先 build 双 workspace + electron-rebuild ABI）：
//   npx pnpm@9.0.0 build && cd electron && npx electron-rebuild -f -w better-sqlite3 -w keytar
//   npx pnpm@9.0.0 e2e tests/e2e/hub-distribution.spec.ts
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const electronRequire = createRequire(path.join(__dirname, '..', '..', 'electron', 'package.json'));
const ELECTRON_APP_DIR = path.join(__dirname, '..', '..', 'electron');

// ──────────────────────────────────────────────────────────────────────────
// 常量与临时目录
// ──────────────────────────────────────────────────────────────────────────

const WS_NAME = 'e2e-hub-dist-ws';
const SKILL_SLUG = 'e2e-hub-dist-skill';
const SKILL_PUBLISH_VERSION = '1.0.1';
const CHAIN_SLUG = 'chain-skill';
const TASK_ID = 'task-e2e-readonly';
const MIRROR_ID = 'mirror-e2e-1';
const ENROLL_TOKEN = 'join-e2e-token';
/** mock hub 固定邀请码（group.invite 应答——场景7 B 凭此入组） */
const INVITE_CODE = 'e2e-invite';

// ── M4.0 T3（HITL 远程代答）常量 ────────────────────────────────────────────

/**
 * mock hub 协议版本——必须与 momo-hub pin 对齐（pin v0.4.0 → 协议 1.8.0）。
 * ⚠️ 协议升级（pin bump）时必须与 electron/tests/hub/protocol-pin.test.ts
 * 同步更新本常量，否则 hubSupportsMinor(3) 代答门控与真实 pin 漂移
 * （场景7 正例门控 / 场景8 负例门控的前提）。
 */
const HUB_PROTO_VER = '1.8.0';
/** 低版本负例节点名：hello 回 1.2.0（major 同 → 客户端可连接，minor 3 < 代答门控） */
const LOW_NODE_NAME = 'e2e-node-low';
const LOW_HUB_PROTO_VER = '1.2.0';
const HITL_WS_NAME = 'e2e-hitl-low-ws';
const HITL_TASK_TITLE = 'e2e HITL 代答任务';

const runId = `${Date.now()}-${process.pid}`;
const tmpRoot = path.join(os.tmpdir(), `momo-hub-dist-e2e-${runId}`);
const userA = path.join(tmpRoot, 'profile-a');
const userB = path.join(tmpRoot, 'profile-b');
const userC = path.join(tmpRoot, 'profile-c');
const wsDirA = path.join(tmpRoot, 'ws-a');
const denyFile = path.join(os.homedir(), `momo-e2e-hub-deny-${runId}.txt`);

// ──────────────────────────────────────────────────────────────────────────
// mock hub / mock LLM 状态
// ──────────────────────────────────────────────────────────────────────────

/** 单版本记录（publish 收包 / 预种子共用） */
interface VersionRec {
  version: string;
  manifest: Record<string, unknown>;
  bytes: Buffer;
  checksum: string;
  sizeBytes: number;
  publishedAt: number;
}

interface WsLike {
  send(data: string): void;
  close(): void;
  terminate(): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

/** 宽松 semver 比较（数值段 + 缺段按 0——version-compare 同语义子集） */
function semverCompare(a: string, b: string): number {
  const seg = (v: string, i: number): number => {
    const s = v.split('+', 1)[0]!.split('.')[i];
    return s !== undefined && /^[0-9]+$/.test(s) ? Number(s) : 0;
  };
  const len = Math.max(a.split('.').length, b.split('.').length);
  for (let i = 0; i < len; i += 1) {
    const d = seg(a, i) - seg(b, i);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const hub = {
  server: null as HttpServer | null,
  baseUrl: '',
  /** slug → 资源（type + 归属 + 全版本）——M5.0：ownerNodeId 领地判定输入 */
  resources: new Map<string, { type: string; ownerNodeId?: string; versions: Map<string, VersionRec> }>(),
  /** snapshotId → 存档 */
  snapshots: new Map<string, { bytes: Buffer; checksum: string; workspaceName: string }>(),
  /** POST /resources/publish 收包记录（manifest part 解析面） */
  publishRequests: [] as Array<{ slug: string; type: string; version: string; author: string }>,
  /** POST /workspaces/snapshots 收包记录 */
  snapshotUploads: [] as Array<{ workspaceName: string; version: string; resources: number }>,
  /** 下载计数：`${slug}@${version}` → 次数 */
  downloads: new Map<string, number>(),
  /** task.report 上报捕获：taskId → payloads */
  taskReports: new Map<string, Array<{ status: string; progress?: { kind?: string; excerpt?: string } }>>(),
  /** mirror.apply 回执捕获：mirrorId(=req id) → {ok, payload} */
  mirrorReceipts: new Map<string, { ok: boolean; payload: Record<string, unknown> }>(),
  /** 已定向下发的 mirror.apply req id 集（res 回捕对账） */
  pendingMirrors: new Set<string>(),
  /** 工作组账本（group.create/list 消费） */
  groups: [] as Array<{
    groupId: string; groupName: string; leaderNodeId: string;
    members: Array<{ nodeId: string; name: string; online: boolean }>;
  }>,
  /** deviceToken → 节点 */
  nodes: new Map<string, { nodeId: string; nodeName: string }>(),
  /** nodeId → 活跃 ws 连接（定向下发面） */
  conns: new Map<string, WsLike>(),
  allSockets: new Set<WsLike>(),
  /** mock LLM：SSE 剧本（'deny-write' | 'final-text' | 'hold'，消费即清；hold=T3
   *  worker 保持 running 无终态——单 chunk 后 SSE 挂起不收尾） */
  llmScript: [] as Array<'deny-write' | 'final-text' | 'hold'>,
  /** M4.0 T3：委派账本（taskId → 路由元数据——task.delegate 记账，answer/progress 定向用） */
  delegations: new Map<string, { leaderNodeId: string; workerNodeId: string; workspaceName: string }>(),
  /** task.answer 收包记录（leader 决策对账断言面） */
  answerRequests: [] as Array<{ taskId: string; decision: 'approve' | 'deny' }>,
  /** 已向 leader 转发过进度拍的委派（首拍转发即停——mock 边界④，见文件头） */
  progressForwarded: new Set<string>(),
  /** 委派 taskId 序号（task-hub-N） */
  taskSeq: 0,
};

function downloadCount(slug: string, version: string): number {
  return hub.downloads.get(`${slug}@${version}`) ?? 0;
}

/** hub 侧登记一个资源版本（预种子 / 用例内升版共用；broadcast=true 时向全部在线节点发 resource.published。
 *  M5.0 领地制：owner 在场时沿用（owner 放行语义）；缺省 = 首发认领为该 owner。事件携 ownerNodeId。 */
function hubPublishVersion(rec: {
  slug: string; type: string; name: string; version: string; author: string;
  description: string; readme: string; tags: string[]; category: string; iconEmoji: string;
  bytes: Buffer;
  ownerNodeId?: string;
}, broadcast: boolean): void {
  const entry = hub.resources.get(rec.slug) ?? { type: rec.type, versions: new Map<string, VersionRec>() };
  const ownerNodeId = entry.ownerNodeId ?? rec.ownerNodeId;
  const manifest: Record<string, unknown> = {
    slug: rec.slug, type: rec.type, name: rec.name, version: rec.version, author: rec.author,
    description: rec.description, readme: rec.readme, tags: rec.tags, category: rec.category,
    iconEmoji: rec.iconEmoji, verificationStatus: 'unverified',
  };
  entry.versions.set(rec.version, {
    version: rec.version,
    manifest,
    bytes: rec.bytes,
    checksum: crypto.createHash('sha256').update(rec.bytes).digest('hex'),
    sizeBytes: rec.bytes.length,
    publishedAt: Date.now(),
  });
  hub.resources.set(rec.slug, { ...entry, ...(ownerNodeId !== undefined ? { ownerNodeId } : {}) });
  if (!broadcast) return;
  broadcastEvt('resource.published', {
    slug: rec.slug, type: rec.type, name: rec.name, version: rec.version, author: rec.author, at: Date.now(),
    ...(ownerNodeId !== undefined ? { ownerNodeId } : {}),
  });
}

/** 目录装配：latest = versions 全集 semver max（hub v0.1.5 语义），versions 降序；
 *  M5.0：条目投影 ownerNodeId（无主不带键——协议 1.8.0 可选字段） */
function buildCatalog(): Record<string, unknown> {
  const items = [...hub.resources.entries()].map(([slug, entry]) => {
    const versions = [...entry.versions.values()].sort((a, b) => semverCompare(b.version, a.version));
    const latest = versions[0]!;
    const m = latest.manifest as Record<string, string>;
    return {
      slug,
      type: entry.type,
      name: m.name,
      version: latest.version,
      author: m.author,
      description: m.description,
      readme: m.readme,
      tags: latest.manifest.tags as string[],
      category: m.category,
      iconEmoji: m.iconEmoji,
      verificationStatus: 'unverified',
      downloadUrl: `/resources/${encodeURIComponent(slug)}/${encodeURIComponent(latest.version)}/download`,
      checksum: latest.checksum,
      sizeBytes: latest.sizeBytes,
      publishedAt: latest.publishedAt,
      versions: versions.map((v) => v.version),
      ...(entry.ownerNodeId !== undefined ? { ownerNodeId: entry.ownerNodeId } : {}),
    };
  });
  return { version: '1', updatedAt: new Date().toISOString(), items };
}

function broadcastEvt(method: string, payload: unknown): void {
  const env = JSON.stringify({ v: 1, kind: 'evt', method, payload });
  for (const sock of hub.allSockets) {
    try { sock.send(env); } catch { /* 连接半关——忽略 */ }
  }
}

function sendToNode(nodeId: string, env: Record<string, unknown>): boolean {
  const sock = hub.conns.get(nodeId);
  if (!sock) return false;
  try { sock.send(JSON.stringify(env)); return true; } catch { return false; }
}

/** nodeId → 节点名（mock hub 反查——hello 按节点名区分协议版本用） */
function nodeNameOf(nodeId: string): string | null {
  for (const node of hub.nodes.values()) {
    if (node.nodeId === nodeId) return node.nodeName;
  }
  return null;
}

/**
 * M4.0 T3：向委派 leader 合成 waiting 拍（mock 边界①，见文件头——真实产生点 =
 * worker runner L1b sessionWaiting 自发上报；此处直发 task.progress 事件，
 * 形状对齐协议 TaskProgressEvent：{taskId, sessionId, lastSeq, excerpt, kind}）
 */
function hubPushWaitingProgress(taskId: string): boolean {
  const dlg = hub.delegations.get(taskId);
  if (!dlg) return false;
  return sendToNode(dlg.leaderNodeId, {
    v: 1,
    kind: 'evt',
    method: 'task.progress',
    payload: {
      taskId,
      sessionId: `sess-mock-${taskId}`,
      lastSeq: 1,
      excerpt: '等待节点写入授权确认',
      kind: 'waiting-input',
    },
  });
}

/**
 * M4.0 T3：合成 workspace.mirrored 组内广播（mock 边界②，见文件头——真实链 =
 * 镜像向导 + mirror.apply 回执，本文件场景2/3 已锁；此处为 RunRoutingField
 * 预检门与 pickWorker mirroredBy 候选最小造数，形状对齐 WorkspaceMirroredEvent）
 */
function hubBroadcastMirrored(rec: {
  groupId: string; targetNodeId: string; workspaceName: string; snapshotId: string;
}): void {
  broadcastEvt('workspace.mirrored', { ...rec, appliedResources: [] });
}

/** multipart/form-data 手工解析（undici FormData 产出形态：\r\n 分隔 + boundary） */
function parseMultipart(body: Buffer, contentType: string): Array<{ name: string; filename?: string; data: Buffer }> {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (m?.[1] ?? m?.[2])?.trim();
  if (boundary === undefined || boundary === '') return [];
  const delim = Buffer.from(`--${boundary}`);
  const parts: Array<{ name: string; filename?: string; data: Buffer }> = [];
  let start = body.indexOf(delim);
  while (start !== -1) {
    const next = body.indexOf(delim, start + delim.length);
    if (next === -1) break;
    let seg = body.subarray(start + delim.length, next);
    if (seg.length >= 2 && seg[0] === 13 && seg[1] === 10) seg = seg.subarray(2);
    if (seg.length >= 2 && seg[seg.length - 2] === 13 && seg[seg.length - 1] === 10) {
      seg = seg.subarray(0, seg.length - 2);
    }
    const headerEnd = seg.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = seg.subarray(0, headerEnd).toString('utf-8');
      const nameMatch = /name="([^"]*)"/.exec(headerText);
      const fileMatch = /filename="([^"]*)"/.exec(headerText);
      if (nameMatch?.[1] !== undefined) {
        parts.push({ name: nameMatch[1], filename: fileMatch?.[1], data: seg.subarray(headerEnd + 4) });
      }
    }
    start = next;
  }
  return parts;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function bearerNode(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  return hub.nodes.get(auth.slice('Bearer '.length))?.nodeId ?? null;
}

/** skill 归档构造（tar.gz，SKILL.md 在根——installPackage 解压即注册面） */
async function buildSkillArchive(slug: string, version: string): Promise<Buffer> {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), `momo-hub-e2e-${slug}-`));
  try {
    fs.writeFileSync(
      path.join(stage, 'SKILL.md'),
      `---\nname: ${slug}\ndescription: ${slug} e2e fixture\nversion: ${version}\n---\n\n# ${slug} ${version}\n\nhub distribution e2e fixture.\n`,
    );
    const archive = path.join(stage, 'pkg.tar.gz');
    await execFileAsync('tar', ['czf', archive, '-C', stage, 'SKILL.md']);
    return fs.readFileSync(archive);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** WS req 应答（同 id res 信封） */
function replyReq(sock: WsLike, req: { id: string; method: string }, ok: boolean, payload: unknown): void {
  sock.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, method: req.method, ok, payload }));
}

/** mock hub WS 消息面：req（hello/ping/组/委派对账）+ res（task.report / mirror.receipt 捕获） */
function handleWsMessage(sock: WsLike, raw: unknown, selfNodeId: string): void {
  let env: { kind?: string; id?: string; method?: string; ok?: boolean; payload?: unknown };
  try {
    env = JSON.parse(String(raw)) as { kind?: string; id?: string; method?: string; ok?: boolean; payload?: unknown };
  } catch {
    return;
  }

  // ── res 信封：studio 主动上行面（task.report；mirror.apply 的回执）──
  if (env.kind === 'res' && typeof env.id === 'string' && typeof env.method === 'string') {
    if (env.method === 'task.report') {
      const payload = (env.payload ?? {}) as { status?: string; sessionId?: string; progress?: { kind?: string; excerpt?: string; lastSeq?: number } };
      const q = hub.taskReports.get(env.id) ?? [];
      q.push({ status: payload.status ?? 'unknown', progress: payload.progress });
      hub.taskReports.set(env.id, q);
      // M4.0 T3：真实 hub 将 worker 上报转发 leader（task.progress 事件）。
      // mock 边界④（见文件头）：只转发首拍——后续拍抑制，防 hold 剧本零星
      // 增量拍冲掉合成 waiting 态；等待→代答链不依赖后续拍
      const dlg = hub.delegations.get(env.id);
      const prog = payload.progress;
      if (
        dlg && !hub.progressForwarded.has(env.id) && prog &&
        typeof prog.lastSeq === 'number' && typeof prog.excerpt === 'string' &&
        typeof payload.sessionId === 'string'
      ) {
        hub.progressForwarded.add(env.id);
        sendToNode(dlg.leaderNodeId, {
          v: 1,
          kind: 'evt',
          method: 'task.progress',
          payload: { taskId: env.id, sessionId: payload.sessionId, lastSeq: prog.lastSeq, excerpt: prog.excerpt },
        });
      }
      return;
    }
    if (hub.pendingMirrors.has(env.id)) {
      hub.pendingMirrors.delete(env.id);
      hub.mirrorReceipts.set(env.id, { ok: env.ok === true, payload: (env.payload ?? {}) as Record<string, unknown> });
      return;
    }
    return;
  }

  if (env.kind !== 'req' || typeof env.method !== 'string') return;
  const req = { id: env.id ?? '', method: env.method };
  const payload = (env.payload ?? {}) as Record<string, unknown>;

  switch (env.method) {
    case 'hello':
      // M4.0 T3：protoVer 常量锚定 pin（HUB_PROTO_VER——协议升级时与
      // electron/tests/hub/protocol-pin.test.ts 同步更新）；低版本负例节点回
      // 1.2.0（major 同 → 客户端 isCompatible 通过可连接，minor 3 < 代答门控）
      replyReq(sock, req, true, {
        hubId: 'e2e-hub-mock',
        protoVer: nodeNameOf(selfNodeId) === LOW_NODE_NAME ? LOW_HUB_PROTO_VER : HUB_PROTO_VER,
        serverTime: Date.now(),
        onlineNodes: [],
      });
      return;
    case 'ping':
      replyReq(sock, req, true, { ts: (payload as { ts?: number }).ts ?? Date.now(), serverTime: Date.now() });
      return;
    case 'group.create': {
      const groupName = String(payload.groupName ?? 'e2e 组');
      const groupId = `g-e2e-${hub.groups.length + 1}`;
      const node = selfNodeId !== '' ? [...hub.nodes.values()].find((n) => n.nodeId === selfNodeId) : undefined;
      hub.groups.push({
        groupId,
        groupName,
        leaderNodeId: selfNodeId,
        members: [{ nodeId: selfNodeId, name: node?.nodeName ?? selfNodeId, online: true }],
      });
      replyReq(sock, req, true, { groupId, nodeId: selfNodeId });
      return;
    }
    case 'group.list':
      // M4.0 T3 收紧为节点视角（真实 hub 语义：只回请求节点所在的组）——
      // 之前全量返回会让多组节点的 RunRoutingField 默认选中首组（别人的组）
      replyReq(sock, req, true, {
        groups: hub.groups.filter((g) => g.members.some((m) => m.nodeId === selfNodeId)),
      });
      return;
    case 'group.invite':
      replyReq(sock, req, true, { inviteCode: INVITE_CODE });
      return;
    case 'group.join': {
      // M4.0 T3：入组——最新组加成员 + 组内广播 group.changed（GroupChangedEvent
      // 形状 {groupId, kind:'joined', nodeId}——真实 hub 语义）
      const group = hub.groups[hub.groups.length - 1];
      if (!group) {
        replyReq(sock, req, false, { code: 'not_found', message: '无组可加入' });
        return;
      }
      if (!group.members.some((m) => m.nodeId === selfNodeId)) {
        group.members.push({ nodeId: selfNodeId, name: nodeNameOf(selfNodeId) ?? selfNodeId, online: true });
      }
      broadcastEvt('group.changed', { groupId: group.groupId, kind: 'joined', nodeId: selfNodeId });
      replyReq(sock, req, true, { groupId: group.groupId });
      return;
    }
    case 'group.leave':
    case 'group.transfer':
      replyReq(sock, req, true, { ok: true });
      return;
    case 'task.list':
      replyReq(sock, req, true, { tasks: [] });
      return;
    case 'task.delegate': {
      // M4.0 T3 升级：记账 + 定向 task.assigned 下发 worker（TaskAssignedEvent
      // 形状 + permissionTier 容错扩展字段——协议 1.2.0 起向后兼容）；低版本
      // 负例 leader 不下发（场景8 无 worker 参与，只锁 leader 菜单门控）
      hub.taskSeq += 1;
      const taskId = `task-hub-${hub.taskSeq}`;
      const targetNodeId = typeof payload.targetNodeId === 'string' ? payload.targetNodeId : '';
      const workspaceName = typeof payload.workspaceName === 'string' ? payload.workspaceName : '';
      hub.delegations.set(taskId, { leaderNodeId: selfNodeId, workerNodeId: targetNodeId, workspaceName });
      const task = (payload.task ?? {}) as { title?: unknown; prompt?: unknown; permissionTier?: unknown };
      const workerIsLeaderTarget = nodeNameOf(selfNodeId) === LOW_NODE_NAME;
      if (!workerIsLeaderTarget && targetNodeId !== '') {
        sendToNode(targetNodeId, {
          v: 1,
          kind: 'evt',
          method: 'task.assigned',
          payload: {
            taskId,
            workspaceName,
            task: {
              title: typeof task.title === 'string' ? task.title : 'e2e 委派任务',
              prompt: typeof task.prompt === 'string' ? task.prompt : 'e2e 委派任务书',
              ...(task.permissionTier !== undefined ? { permissionTier: task.permissionTier } : {}),
            },
            byNode: selfNodeId,
          },
        });
      }
      replyReq(sock, req, true, { taskId });
      return;
    }
    case 'task.cancel':
      replyReq(sock, req, true, { ok: true });
      return;
    case 'task.answer': {
      // M4.0 T3：leader 代答决策（mock 边界③，见文件头）——校验载荷 → 回
      // {disposition:'granted'} 并按协议 TaskAnsweredEvent 形状
      // {taskId, decision, by, disposition} 向 leader/worker 推 task.answered
      const taskId = typeof payload.taskId === 'string' ? payload.taskId : '';
      const decision = payload.decision === 'approve' || payload.decision === 'deny' ? payload.decision : null;
      if (taskId === '' || decision === null) {
        replyReq(sock, req, false, { code: 'bad_request', message: 'task.answer 载荷非法（taskId + decision approve|deny）' });
        return;
      }
      hub.answerRequests.push({ taskId, decision });
      const evt = {
        v: 1,
        kind: 'evt',
        method: 'task.answered',
        payload: { taskId, decision, by: selfNodeId, disposition: 'granted' },
      };
      const dlg = hub.delegations.get(taskId);
      if (dlg) {
        sendToNode(dlg.leaderNodeId, evt);
        if (dlg.workerNodeId !== '') sendToNode(dlg.workerNodeId, evt);
      }
      replyReq(sock, req, true, { disposition: 'granted' });
      return;
    }
    default:
      // view.consent 等其余方法——ok 容忍（协议未知容忍语义）
      replyReq(sock, req, true, { ok: true });
      return;
  }
}

/** 起 mock hub（HTTP 数据面 + /ws 控制面 + mock LLM 同端口） */
async function startMockHub(): Promise<void> {
  const { WebSocketServer } = electronRequire('ws') as {
    WebSocketServer: new (opts: { noServer: boolean }) => {
      on(event: 'connection', cb: (sock: WsLike, req: IncomingMessage) => void): void;
      handleUpgrade(req: IncomingMessage, socket: unknown, head: Buffer, cb: (sock: WsLike) => void): void;
    };
  };
  const wss = new WebSocketServer({ noServer: true });
  let nodeSeq = 0;

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '').split('?')[0]!;
    const method = req.method ?? 'GET';

    // ---- mock LLM（OpenAI 兼容；provider baseUrl 指向 {hub}/v1）----
    if (url === '/v1/chat/completions' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf-8')) as { stream?: boolean };
      if (body.stream !== true) {
        // 非流式（会话命名等杂项）——极简 JSON
        sendJson(res, 200, { choices: [{ message: { content: '委派任务' }, finish_reason: 'stop' }] });
        return;
      }
      const step = hub.llmScript.shift();
      if (step === 'hold') {
        // M4.0 T3：worker 保持剧本——单 chunk 后 SSE 挂起不收尾（turn 无终态，
        // B 侧持续 running；waiting 态由 mock hub 合成注入，mock 边界①见文件头）。
        // 安全阀 300s：正常路径不可达（测试收摊关 app 即断连），防连接悬挂
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '任务已接收，正在处理。' } }] })}\n\n`);
        setTimeout(() => res.end(), 300_000);
        return;
      }
      let chunks: Array<Record<string, unknown>>;
      if (step === 'deny-write') {
        const args = JSON.stringify({ command: `touch '${denyFile}'` });
        chunks = [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_e2e_deny', function: { name: 'bash', arguments: '' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ];
      } else {
        chunks = [
          { choices: [{ delta: { content: '已按只读约束处理，任务结束。' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ];
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      // final 延迟 1500ms——保证 denied 进度拍先于回合终态上报（runner tick 500ms 合并窗）
      const delay = step === 'final-text' ? 1500 : 0;
      setTimeout(() => {
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }, delay);
      return;
    }

    // ---- enroll（无鉴权）----
    if (url === '/enroll' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf-8')) as { nodeName?: string };
      nodeSeq += 1;
      const nodeId = `node-e2e-${nodeSeq}`;
      const deviceToken = `tok-e2e-${nodeSeq}`;
      hub.nodes.set(deviceToken, { nodeId, nodeName: body.nodeName ?? nodeId });
      sendJson(res, 200, { nodeId, deviceToken });
      return;
    }

    // ---- 以下数据面端点全部 Bearer 鉴权（hub spec §3.1）----
    if (bearerNode(req) === null) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (url === '/resources/catalog' && method === 'GET') {
      sendJson(res, 200, buildCatalog());
      return;
    }

    if (url === '/resources/publish' && method === 'POST') {
      const publisherNodeId = bearerNode(req)!;
      const body = await readBody(req);
      const parts = parseMultipart(body, req.headers['content-type'] ?? '');
      const manifestPart = parts.find((p) => p.name === 'manifest');
      const packagePart = parts.find((p) => p.name === 'package');
      if (!manifestPart || !packagePart) {
        sendJson(res, 400, { error: 'bad_multipart' });
        return;
      }
      const manifest = JSON.parse(manifestPart.data.toString('utf-8')) as {
        slug: string; type: string; name: string; version: string; author: string;
        description: string; readme: string; tags?: string[]; category?: string; iconEmoji?: string;
      };
      // M5.0 领地制（hub §3 ③.5）：他节点领地 → 403 not_owner（携 owner_name，
      // 先于 409 version_exists）；新 slug 认领为发布者
      const territory = hub.resources.get(manifest.slug);
      if (territory?.ownerNodeId !== undefined && territory.ownerNodeId !== publisherNodeId) {
        sendJson(res, 403, {
          error: 'not_owner',
          owner_name: nodeNameOf(territory.ownerNodeId) ?? 'unknown',
        });
        return;
      }
      hubPublishVersion(
        {
          slug: manifest.slug, type: manifest.type, name: manifest.name, version: manifest.version,
          author: manifest.author, description: manifest.description, readme: manifest.readme,
          tags: Array.isArray(manifest.tags) ? manifest.tags : [],
          category: manifest.category ?? '', iconEmoji: manifest.iconEmoji ?? '📦',
          bytes: packagePart.data,
          ownerNodeId: publisherNodeId,
        },
        true,
      );
      hub.publishRequests.push({
        slug: manifest.slug, type: manifest.type, version: manifest.version, author: manifest.author,
      });
      const rec = hub.resources.get(manifest.slug)!.versions.get(manifest.version)!;
      sendJson(res, 201, {
        slug: manifest.slug, version: manifest.version, checksum: rec.checksum, sizeBytes: rec.sizeBytes,
      });
      return;
    }

    const downloadMatch = /^\/resources\/([^/]+)\/([^/]+)\/download$/.exec(url);
    if (downloadMatch && method === 'GET') {
      const slug = decodeURIComponent(downloadMatch[1]!);
      const version = decodeURIComponent(downloadMatch[2]!);
      const rec = hub.resources.get(slug)?.versions.get(version);
      if (!rec) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      const key = `${slug}@${version}`;
      hub.downloads.set(key, (hub.downloads.get(key) ?? 0) + 1);
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': rec.bytes.length });
      res.end(rec.bytes);
      return;
    }

    if (url === '/workspaces/snapshots' && method === 'POST') {
      const body = await readBody(req);
      const parts = parseMultipart(body, req.headers['content-type'] ?? '');
      const manifestPart = parts.find((p) => p.name === 'manifest');
      const payloadPart = parts.find((p) => p.name === 'payload');
      if (!manifestPart || !payloadPart) {
        sendJson(res, 400, { error: 'bad_multipart' });
        return;
      }
      const manifest = JSON.parse(manifestPart.data.toString('utf-8')) as {
        workspaceName: string; version: string; resources: unknown[];
      };
      const snapshotId = `snap-e2e-${hub.snapshots.size + 1}`;
      hub.snapshots.set(snapshotId, {
        bytes: payloadPart.data,
        checksum: crypto.createHash('sha256').update(payloadPart.data).digest('hex'),
        workspaceName: manifest.workspaceName,
      });
      hub.snapshotUploads.push({
        workspaceName: manifest.workspaceName, version: manifest.version, resources: manifest.resources.length,
      });
      sendJson(res, 201, { snapshotId, checksum: hub.snapshots.get(snapshotId)!.checksum });
      return;
    }

    const snapshotDownload = /^\/workspaces\/snapshots\/([^/]+)\/download$/.exec(url);
    if (snapshotDownload && method === 'GET') {
      const snap = hub.snapshots.get(decodeURIComponent(snapshotDownload[1]!));
      if (!snap) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Length': snap.bytes.length,
        'X-Checksum-Sha256': snap.checksum,
      });
      res.end(snap.bytes);
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = (req.url ?? '').split('?')[0]!;
    if (url !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (sock) => {
      const auth = req.headers.authorization;
      const nodeId = typeof auth === 'string' && auth.startsWith('Bearer ')
        ? (hub.nodes.get(auth.slice('Bearer '.length))?.nodeId ?? '')
        : '';
      if (nodeId !== '') hub.conns.set(nodeId, sock);
      hub.allSockets.add(sock);
      sock.on('message', (raw) => handleWsMessage(sock, raw, nodeId));
      sock.on('close', () => {
        hub.allSockets.delete(sock);
        for (const [id, s] of hub.conns) if (s === sock) hub.conns.delete(id);
      });
      sock.on('error', () => { /* 连接错误——close 兜底清理 */ });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      hub.baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
  hub.server = server;
}

// ──────────────────────────────────────────────────────────────────────────
// Electron 启动 / 通用 UI helper（沿 smoke/browser/composer spec 既有模式）
// ──────────────────────────────────────────────────────────────────────────

async function launchApp(userData: string): Promise<ElectronApplication> {
  const electronPath = electronRequire('electron') as string;
  const app = await electron.launch({
    // --user-data-dir 隔离 Chromium profile + AP_USER_DATA_DIR 隔离应用级路径
    // （state.db / skills / cache / workspaces）——theme/browser spec 同款先例
    args: [ELECTRON_APP_DIR, '--no-sandbox', `--user-data-dir=${userData}`],
    env: { ...process.env, AP_USER_DATA_DIR: userData },
    colorScheme: 'dark',
    timeout: 30000,
  });
  app.process().once('exit', (code) => {
    if (code !== 0) throw new Error(`Electron main process exited with code ${code}`);
  });
  return app;
}

/** 跳过首启引导 → 内嵌表单创建工作空间 → 主布局就绪 */
async function skipOnboardingAndCreateWorkspace(win: Page, name: string, dir: string): Promise<void> {
  await win.getByRole('button', { name: '跳过引导' }).click({ timeout: 15000 });
  await win.getByLabel('名称').fill(name);
  await win.getByPlaceholder('选择或输入目录路径').fill(dir);
  await win.getByRole('button', { name: '创建', exact: true }).click();
  await expect(win.getByLabel('智能体', { exact: true })).toBeVisible({ timeout: 20000 });
}

/** 设置 → 节点互联 → enroll 表单接入 → 等已连接（WS hello 成功） */
async function enrollViaSettings(win: Page, nodeName: string): Promise<void> {
  await win.getByRole('button', { name: '设置', exact: true }).click();
  await win.getByRole('button', { name: '节点互联' }).click();
  await win.getByLabel('hub 地址').fill(hub.baseUrl);
  await win.getByLabel('节点名').fill(nodeName);
  await win.getByLabel('加入凭证').fill(ENROLL_TOKEN);
  await win.getByRole('button', { name: '接入', exact: true }).click();
  await expect(win.getByText('已连接', { exact: true })).toBeVisible({ timeout: 20000 });
}

/** 等某节点的 ws 连接在场（定向下发前提——enroll 后 hello 握手完成） */
async function waitForNodeConn(nodeName: string): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    for (const [, node] of hub.nodes) {
      if (node.nodeName === nodeName && hub.conns.has(node.nodeId)) return node.nodeId;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`节点 ${nodeName} 的 hub 连接未就绪`);
}

// ──────────────────────────────────────────────────────────────────────────
// 六场景（serial：场景 1/2/4/5/6 共享实例 A；场景 3 用全新 profile 实例 B）
// ──────────────────────────────────────────────────────────────────────────

test.describe.serial('hub 分发链 / readonly 即时拒 / 版本链（M2.3 Task 7 + M4.0 T3 HITL 代答）', () => {
  let appA: ElectronApplication | null = null;
  let winA: Page | null = null;
  let appB: ElectronApplication | null = null;
  /** 场景3 打开的实例 B 窗口（场景7 复用——B 侧 HITL worker 链） */
  let winBHitl: Page | null = null;
  let appC: ElectronApplication | null = null;
  /** 场景7 记账的委派 taskId（场景8 区分 C 的新委派用） */
  let hitl7TaskId = '';

  test.beforeAll(async () => {
    fs.mkdirSync(userA, { recursive: true });
    fs.mkdirSync(userB, { recursive: true });
    fs.mkdirSync(userC, { recursive: true });
    fs.mkdirSync(wsDirA, { recursive: true });
    await startMockHub();
    // 预种子版本链 skill v1.0.0（场景 5 安装起点——不广播事件，静默在目录）
    hubPublishVersion(
      {
        slug: CHAIN_SLUG, type: 'skill', name: CHAIN_SLUG, version: '1.0.0', author: 'e2e-seed',
        description: '版本链 e2e fixture', readme: `# ${CHAIN_SLUG} v1`, tags: [], category: '',
        iconEmoji: '📦', bytes: await buildSkillArchive(CHAIN_SLUG, '1.0.0'),
      },
      false,
    );
  });

  test.afterAll(async () => {
    await appA?.close().catch(() => undefined);
    await appB?.close().catch(() => undefined);
    await appC?.close().catch(() => undefined);
    for (const sock of hub.allSockets) {
      try { sock.terminate(); } catch { /* 已关 */ }
    }
    hub.server?.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(denyFile, { force: true });
  });

  test('场景1 发布→记账：custom skill 发布 → hub 收包 → 库页零 hub 卡（M5.2 发布记账≠已装）', async () => {
    test.setTimeout(240_000);
    appA = await launchApp(userA);
    winA = await appA.firstWindow();
    await winA.waitForLoadState('domcontentloaded');
    await skipOnboardingAndCreateWorkspace(winA, WS_NAME, wsDirA);

    // 种 custom skill（preload 通道——browser/composer spec 同款先例；发布面走 UI）
    await winA.evaluate(async (skillName) => {
      const w = window as unknown as {
        api: {
          resource: { createSkill(input: { name: string; description: string; body: string }): Promise<unknown> };
        };
      };
      await w.api.resource.createSkill({
        name: skillName,
        description: 'hub 分发链 e2e fixture',
        body: '# hub dist e2e\n用于发布→记账→补装链路回归。',
      });
    }, SKILL_SLUG);

    await enrollViaSettings(winA, 'e2e-node-a');

    // 资源库 → Skill 页（custom 卡「发布到 hub」入口）
    await winA.getByRole('button', { name: '资源库', exact: true }).click();
    await winA.getByRole('button', { name: 'Skill', exact: true }).click();
    const customCard = winA.getByTestId(`resource-card-custom-skill-${SKILL_SLUG}`);
    await expect(customCard).toBeVisible({ timeout: 20000 });
    await customCard.getByRole('button', { name: '发布到 hub' }).click();

    const dlg = winA.getByRole('dialog');
    await expect(dlg).toBeVisible();
    await dlg.getByLabel('版本').fill(SKILL_PUBLISH_VERSION);
    await dlg.getByRole('button', { name: '发布', exact: true }).click();

    // 发布成功回执（发布对话框四态机——成功态）
    await expect(dlg.getByText(`已发布 v${SKILL_PUBLISH_VERSION}`)).toBeVisible({ timeout: 30000 });

    // mock hub 收包面：multipart manifest part 解析（slug/type/version/author）
    const pub = hub.publishRequests.find((p) => p.slug === SKILL_SLUG && p.version === SKILL_PUBLISH_VERSION);
    expect(pub, '/resources/publish 应收到 manifest part').toBeDefined();
    expect(pub!.type).toBe('skill');
    expect(pub!.author).toBe('e2e-node-a');

    // M5.2 断言迁移（用户实测回归锁）：发布记账（cache_path 空）≠ 已装——
    // 发布后库页不得出现第二张 hub 卡，只有 custom 本体卡（带「已发布」徽标）
    await expect(winA.getByTestId(`resource-card-hub-skill-${SKILL_SLUG}`)).toHaveCount(0);
    await expect(customCard).toBeVisible();
    await expect(customCard.getByText(/已发布 v/)).toBeVisible();

    // 结构化复核：hub 源列表不映射发布记账行（installed 判定只认真安装）
    const row = await winA.evaluate(async ([slug, type]) => {
      const w = window as unknown as {
        api: {
          resource: {
            list(filter: { type: string; source: string }): Promise<
              Array<{ slug: string; installed: boolean; installedVersion?: string }>
            >;
          };
        };
      };
      const items = await w.api.resource.list({ type, source: 'hub' });
      return items.find((i) => i.slug === slug) ?? null;
    }, [SKILL_SLUG, 'skill'] as const);
    expect(row, '发布记账不得产出 hub 源条目').toBeNull();

    // 收摊：关闭发布对话框（成功态「关闭」钮——防遮罩拦截后续场景点击）
    await dlg.getByRole('button', { name: '关闭' }).click();
    await expect(dlg).toBeHidden();

    // M5.1 场景10 发布版本回写：SKILL.md frontmatter 落发布版本——custom 行
    // version 与 hub 发布态同源（「本地是本体」收口，spec 2026-10-30 §1.2）
    const wb = await winA.evaluate(async ([skillName, pubVer]) => {
      const w = window as unknown as {
        api: {
          resource: {
            list(filter: { type: string; source: string }): Promise<
              Array<{ slug: string; version?: string }>
            >;
          };
        };
      };
      const customs = await w.api.resource.list({ type: 'skill', source: 'custom' });
      return customs.find((i) => i.slug === skillName)?.version ?? null;
    }, [SKILL_SLUG, SKILL_PUBLISH_VERSION] as const);
    expect(wb, '发布后 custom skill 行 version 应=hub 发布版本').toBe(SKILL_PUBLISH_VERSION);
  });

  test('场景2 manifest 携带：镜像向导 S2 构建上传 → Skill 补装计数 ≥1', async () => {
    test.setTimeout(180_000);
    expect(winA, '依赖场景1的实例 A').not.toBeNull();

    // 工作组 → 侧栏创建组（无组空态：创建表单直接展开）
    await winA!.getByRole('button', { name: '工作组', exact: true }).click();
    await winA!.getByLabel('组名').fill('e2e 分发组');
    await winA!.getByRole('button', { name: '创建', exact: true }).click();

    // 监控台组头 + leader 镜像入口
    await expect(winA!.getByText('e2e 分发组').first()).toBeVisible({ timeout: 15000 });
    await winA!.getByRole('button', { name: '镜像工作空间…' }).click();

    const wizard = winA!.getByRole('dialog', { name: '镜像工作空间向导' });
    await expect(wizard).toBeVisible();
    // S1 选空间 → 下一步进 S2（入步自动构建）
    await wizard.getByLabel('工作空间').selectOption({ label: WS_NAME });
    await wizard.getByRole('button', { name: '下一步', exact: true }).click();

    // S2 完成：快照构建清单回填真实计数——已发布 skill 占 resources 补装位（1 补装 + 0 内嵌）
    await expect(wizard.getByText('1 补装 + 0 内嵌')).toBeVisible({ timeout: 45000 });
    await expect(wizard.getByText('已上传 hub 存档', { exact: true })).toBeVisible();

    // mock hub 收包面：POST /workspaces/snapshots manifest part 携带 skill 资源引用
    const upload = hub.snapshotUploads.find((u) => u.workspaceName === WS_NAME);
    expect(upload, '/workspaces/snapshots 应收到快照').toBeDefined();
    expect(upload!.resources, 'manifest.resources 应携带 skill 引用').toBeGreaterThanOrEqual(1);

    // 收摊（不进 S3——本场景只锁构建面）
    await wizard.getByRole('button', { name: '取消' }).click();
    await expect(wizard).toBeHidden();
  });

  test('场景4 readonly 即时拒：bash 越界写 → task.report kind=denied「只读档位」', async () => {
    test.setTimeout(300_000);
    expect(winA, '依赖场景1的实例 A').not.toBeNull();

    // fixture：mock LLM provider + custom agent（bash 工具）+ ws 成员（建后停——委派回合自会拉起）
    await winA!.evaluate(async ([llmBase, wsName, agentSlug]) => {
      const w = window as unknown as {
        api: {
          workspace: { list(): Promise<Array<{ id: string; name: string }>> };
          provider: {
            create(input: {
              name: string; baseUrl: string; apiKey: string; defaultModel?: string; platform?: string;
            }): Promise<{ id: string }>;
          };
          agent: {
            createCustom(input: {
              name: string; slug: string; description: string; systemPrompt: string;
              scope: 'global'; modelProviderId: string; modelName: string;
              defaultTools?: Array<{ kind: string; ref: string }>;
            }): Promise<{ id: string }>;
            assign(workspaceId: string, defId: string, agentUserId: string): Promise<{ instanceId: string }>;
            stop(instanceId: string): Promise<{ ok: boolean }>;
          };
        };
      };
      const ws = (await w.api.workspace.list()).find((x) => x.name === wsName);
      if (!ws) throw new Error('workspace 不存在');
      const prov = await w.api.provider.create({
        name: 'E2E Mock LLM',
        baseUrl: llmBase,
        apiKey: 'e2e-mock-key',
        defaultModel: 'e2e-mock-model',
        platform: 'openai',
      });
      const def = await w.api.agent.createCustom({
        name: '只读执行员',
        slug: agentSlug,
        description: 'readonly deny e2e fixture',
        systemPrompt: '你是 e2e 只读执行员，按要求调用工具。',
        scope: 'global',
        modelProviderId: prov.id,
        modelName: 'e2e-mock-model',
        defaultTools: [{ kind: 'builtin', ref: 'bash' }],
      });
      // agentUserId 必须用生产格式 agent-<slug>-<后缀>：write-blocked 归属解析
      // （resolveStreamOwner 的 sender LIKE 'agent-%'）依赖此前缀，@ 前缀会解析
      // 出 sessionId=null → readonly 即时拒不触发（误弹授权卡）
      const member = await w.api.agent.assign(ws.id, def.id, `agent-${agentSlug}-e2e001`);
      await w.api.agent.stop(member.instanceId);
    }, [`${hub.baseUrl}/v1`, WS_NAME, 'e2e-readonly-worker'] as const);

    // mock LLM 剧本：① tool_call(bash 越界写) ② 终幕文本
    hub.llmScript = ['deny-write', 'final-text'];

    // mock hub 定向 task.assigned（permissionTier=readonly——协议 1.2.0 容错扩展字段）
    const nodeId = await waitForNodeConn('e2e-node-a');
    const sent = sendToNode(nodeId, {
      v: 1,
      kind: 'evt',
      method: 'task.assigned',
      payload: {
        taskId: TASK_ID,
        workspaceName: WS_NAME,
        task: {
          title: '只读越界写验证',
          prompt: '请用 bash 在用户主目录创建一个文件。',
          agentSlug: 'e2e-readonly-worker',
          permissionTier: 'readonly',
        },
        byNode: 'node-e2e-leader',
      },
    });
    expect(sent, 'task.assigned 应送达实例 A 的 hub 连接').toBe(true);

    // 断言面：task.report 进度拍 kind='denied' + excerpt 含「只读档位即时拒绝」
    await expect
      .poll(
        () => {
          const reports = hub.taskReports.get(TASK_ID) ?? [];
          return reports.some(
            (r) => r.status === 'running' && r.progress?.kind === 'denied' &&
              (r.progress.excerpt ?? '').includes('只读档位即时拒绝'),
          );
        },
        { timeout: 180_000, intervals: [1500], message: '应收到 kind=denied 的进度拍（excerpt 含「只读档位即时拒绝」）' },
      )
      .toBe(true);

    // 回合收敛：终态上报（denied 后 mock LLM 收尾 → done）
    await expect
      .poll(
        () => (hub.taskReports.get(TASK_ID) ?? []).some((r) => r.status === 'done' || r.status === 'failed'),
        { timeout: 60000, intervals: [1000] },
      )
      .toBe(true);
    // 越界写确实被拦：目标文件不应存在
    expect(fs.existsSync(denyFile), 'seatbelt 应拦截工作空间外写').toBe(false);
  });

  test('场景5 版本链 v1→v2：安装 v1 → 发布 v2 事件 → 「更新」前进到 v2', async () => {
    test.setTimeout(240_000);
    expect(winA, '依赖场景1的实例 A').not.toBeNull();

    await winA!.getByRole('button', { name: '资源库', exact: true }).click();
    await winA!.getByRole('button', { name: 'Skill', exact: true }).click();

    // 起点：目录预种子 v1.0.0 → 经获取弹窗安装（断言迁移——library-store-split：
    // 未装 hub 目录条目不入库页网格，安装入口迁「＋」菜单远端组 → FetchDialog）
    await winA!.getByRole('button', { name: '添加技能' }).click();
    await winA!.locator('[role="menu"]').getByText('从 momo-hub 获取…').click();
    const fetchDlg = winA!.getByRole('dialog', { name: '从 momo-hub 获取技能' });
    await expect(fetchDlg).toBeVisible({ timeout: 20000 });
    const fetchRow = fetchDlg.getByTestId(`fetch-row-hub-skill-${CHAIN_SLUG}`);
    await expect(fetchRow).toBeVisible({ timeout: 20000 });
    await fetchRow.getByRole('button', { name: '安装', exact: true }).click();
    await expect(winA!.getByTestId('install-notice')).toContainText(`已从 momo-hub 安装「${CHAIN_SLUG}」`, { timeout: 30000 });
    await fetchDlg.getByRole('button', { name: '关闭' }).click();
    await expect(fetchDlg).toBeHidden();

    // 安装后库页出现已装 hub 卡（「全部」口径——收窄语义下已装行入库页）
    const chainCard = winA!.getByTestId(`resource-card-hub-skill-${CHAIN_SLUG}`);
    await expect(chainCard).toBeVisible({ timeout: 20000 });
    await expect(chainCard.getByText('v1.0.0 · 已是最新')).toBeVisible({ timeout: 15000 });
    expect(downloadCount(CHAIN_SLUG, '1.0.0'), 'v1 归档应下载一次').toBe(1);

    // hub 升版 v2.0.0 + resource.published 广播（renderer hubUpdates 角标判定源）
    hubPublishVersion(
      {
        slug: CHAIN_SLUG, type: 'skill', name: CHAIN_SLUG, version: '2.0.0', author: 'e2e-seed',
        description: '版本链 e2e fixture', readme: `# ${CHAIN_SLUG} v2`, tags: [], category: '',
        iconEmoji: '📦', bytes: await buildSkillArchive(CHAIN_SLUG, '2.0.0'),
      },
      true,
    );

    // 事件驱动「可更新」角标（semver 前进才可更新——D3-4）
    await expect(chainCard.getByText('可更新')).toBeVisible({ timeout: 20000 });
    await expect(chainCard.getByText('v1.0.0 → v2.0.0')).toBeVisible();

    // 更新 → fresh 目录 latest(v2) > 已装(v1) → 前进安装（T2 语义）
    await chainCard.getByRole('button', { name: '更新', exact: true }).click();
    await expect(winA!.getByTestId('install-notice')).toContainText(`已从 momo-hub 更新「${CHAIN_SLUG}」`, { timeout: 45000 });
    await expect(chainCard.getByText('v2.0.0 · 已是最新')).toBeVisible({ timeout: 20000 });

    // 下载面：v2 一次；v1 不重复
    expect(downloadCount(CHAIN_SLUG, '2.0.0'), 'v2 归档应下载一次').toBe(1);
    expect(downloadCount(CHAIN_SLUG, '1.0.0'), 'v1 不应重复下载').toBe(1);
  });

  test('场景6 已是最新如实报：同版再装 → alreadyLatest 零动作不重装', async () => {
    test.setTimeout(120_000);
    expect(winA, '依赖场景5的 v2 已装态').not.toBeNull();

    const result = await winA!.evaluate(async (id) => {
      const w = window as unknown as {
        api: { resource: { install(id: string): Promise<Record<string, unknown>> } };
      };
      return w.api.resource.install(id);
    }, `hub-skill-${CHAIN_SLUG}`);

    // HubInstallResult 契约（M2.3 T2）：alreadyLatest:true + 已装版本如实回传
    expect((result as { alreadyLatest?: boolean }).alreadyLatest).toBe(true);
    expect((result as { version?: string }).version).toBe('2.0.0');

    // 零动作：无第二次下载（不重装——不谎报「已更新」）
    expect(downloadCount(CHAIN_SLUG, '2.0.0'), '同版再装不得重复下载').toBe(1);
  });

  test('场景3 全新 profile 零 unresolved：mirror.apply → 补装 skill → 回执无 skill:*', async () => {
    test.setTimeout(300_000);

    // 全新 profile 实例 B（隔离 userData——零工作空间零 skill 记账）
    appB = await launchApp(userB);
    const winB = await appB.firstWindow();
    winBHitl = winB;
    await winB.waitForLoadState('domcontentloaded');
    await winB.getByRole('button', { name: '跳过引导' }).click({ timeout: 15000 });
    // 不建工作空间——镜像 apply 会创建（ensureWorkspace 落 <userData>/workspaces）
    await enrollViaSettings(winB, 'e2e-node-b');

    // 场景2 上传的快照 → 定向 mirror.apply 到 B（req id = mirrorId 对账键）
    const snapshot = hub.snapshotUploads.find((u) => u.workspaceName === WS_NAME);
    expect(snapshot, '依赖场景2的快照存档').toBeDefined();
    const snapshotId = [...hub.snapshots.entries()].find(([, s]) => s.workspaceName === WS_NAME)![0];
    const nodeB = await waitForNodeConn('e2e-node-b');
    hub.pendingMirrors.add(MIRROR_ID);
    const sent = sendToNode(nodeB, {
      v: 1,
      kind: 'req',
      id: MIRROR_ID,
      method: 'mirror.apply',
      payload: { mirrorId: MIRROR_ID, snapshotId, workspaceName: WS_NAME, strategy: 'replace' },
    });
    expect(sent, 'mirror.apply 应送达实例 B').toBe(true);

    // 回执：ok + appliedResources 含补装 skill + unresolvedRefs 无 skill:*
    await expect
      .poll(() => hub.mirrorReceipts.has(MIRROR_ID), { timeout: 180_000, intervals: [1500], message: '应收到 mirror.receipt' })
      .toBe(true);
    const receipt = hub.mirrorReceipts.get(MIRROR_ID)!;
    expect(receipt.ok, `镜像应成功应用（payload: ${JSON.stringify(receipt.payload)}）`).toBe(true);
    const applied = receipt.payload['appliedResources'] as string[];
    expect(applied, '补装清单应含 skill/e2e-hub-dist-skill').toContain(`skill/${SKILL_SLUG}`);
    const unresolved = (receipt.payload['unresolvedRefs'] as string[] | undefined) ?? [];
    expect(
      unresolved.filter((u) => u.startsWith('skill:')),
      '回执不得出现任何 skill:* unresolved（先装后落闭合）',
    ).toEqual([]);

    // 落库面：B 工作空间已建 + hub 记账已装（结构化复核）
    const check = await winB.evaluate(async ([wsName, slug]) => {
      const w = window as unknown as {
        api: {
          workspace: { list(): Promise<Array<{ id: string; name: string }>> };
          resource: {
            list(filter: { type: string; source: string }): Promise<
              Array<{ slug: string; installed: boolean; installedVersion?: string }>
            >;
          };
        };
      };
      const ws = (await w.api.workspace.list()).find((x) => x.name === wsName);
      const rows = await w.api.resource.list({ type: 'skill', source: 'hub' });
      const hit = rows.find((r) => r.slug === slug) ?? null;
      return { hasWs: ws !== undefined, installed: hit?.installed ?? false, version: hit?.installedVersion ?? null };
    }, [WS_NAME, SKILL_SLUG] as const);
    expect(check.hasWs, '镜像应创建同名工作空间').toBe(true);
    expect(check.installed, 'B 应经补装链安装该 skill 并落记账').toBe(true);
    expect(check.version).toBe(SKILL_PUBLISH_VERSION);
  });

  test('场景7 HITL 代答主链：A 委派 B → 等待节点确认 → 批准节点写入 → 已远程批准', async () => {
    test.setTimeout(300_000);
    expect(winA, '依赖场景1的实例 A').not.toBeNull();
    expect(winBHitl, '依赖场景3的实例 B').not.toBeNull();

    // B 侧 fixture（真实面）：mock LLM provider + 委派执行 agent 成员 + 工作空间
    // 默认 agent（task.assigned 不带 agentSlug → runner 走默认 agent 解析）
    await winBHitl!.evaluate(async ([llmBase, wsName, agentSlug]) => {
      const w = window as unknown as {
        api: {
          workspace: {
            list(): Promise<Array<{ id: string; name: string }>>;
            setDefaultAgent(workspaceId: string, instanceId: string | null): Promise<void>;
          };
          provider: { create(input: Record<string, unknown>): Promise<{ id: string }> };
          agent: {
            createCustom(input: Record<string, unknown>): Promise<{ id: string }>;
            assign(workspaceId: string, defId: string, agentUserId: string): Promise<{ instanceId: string }>;
          };
        };
      };
      const ws = (await w.api.workspace.list()).find((x) => x.name === wsName);
      if (!ws) throw new Error('B 侧镜像工作空间不存在（依赖场景3）');
      const prov = await w.api.provider.create({
        name: 'E2E HITL Mock LLM',
        baseUrl: llmBase,
        apiKey: 'e2e-mock-key',
        defaultModel: 'e2e-mock-model',
        platform: 'openai',
      });
      const def = await w.api.agent.createCustom({
        name: 'HITL 执行员',
        slug: agentSlug,
        description: 'hitl answer e2e fixture',
        systemPrompt: '你是 e2e HITL 执行员。',
        scope: 'global',
        modelProviderId: prov.id,
        modelName: 'e2e-mock-model',
      });
      // agentUserId 用生产格式 agent-<slug>-<后缀>（write-blocked 归属解析契约，场景4 同款）
      const member = await w.api.agent.assign(ws.id, def.id, `agent-${agentSlug}-hitl01`);
      await w.api.workspace.setDefaultAgent(ws.id, member.instanceId);
    }, [`${hub.baseUrl}/v1`, WS_NAME, 'e2e-hitl-worker'] as const);

    // A 建组（场景2 已有一组 → 侧栏折叠入口「创建工作组」展开表单）
    await winA!.getByRole('button', { name: '工作组', exact: true }).click();
    await winA!.getByRole('button', { name: '创建工作组' }).click();
    await winA!.getByLabel('组名').fill('e2e HITL 组');
    await winA!.getByRole('button', { name: '创建', exact: true }).click();
    await expect(winA!.getByText('e2e HITL 组').first()).toBeVisible({ timeout: 15000 });

    // B 入组（mock group.invite 恒回固定邀请码）。B 无组空态：加入表单直接
    // 展开（折叠入口「凭邀请码加入」仅已有组的侧栏渲染——WorkgroupSidebar）
    await winBHitl!.getByRole('button', { name: '工作组', exact: true }).click();
    await winBHitl!.getByLabel('邀请码').fill(INVITE_CODE);
    await winBHitl!.getByRole('button', { name: '入组', exact: true }).click();
    await expect(winBHitl!.getByText('e2e HITL 组').first()).toBeVisible({ timeout: 15000 });

    const nodeB = await waitForNodeConn('e2e-node-b');
    const hitlGroup = hub.groups[hub.groups.length - 1]!;
    // 镜像登记合成（mock 边界②）→ A 的 RunRoutingField 预检解锁「组内调度」+ pickWorker 候选=B
    hubBroadcastMirrored({
      groupId: hitlGroup.groupId, targetNodeId: nodeB, workspaceName: WS_NAME, snapshotId: 'snap-e2e-hitl',
    });

    // B 回合剧本：hold（收派后 running 无终态——不冲掉合成 waiting 态）
    hub.llmScript = ['hold'];

    // A 看板建任务 → 执行位置「组内调度」→ 提交（hub task.delegate → mock 记账 + 下发 B）
    await winA!.getByRole('button', { name: '看板', exact: true }).click();
    await winA!.getByRole('button', { name: '新建任务' }).first().click();
    const dlg = winA!.getByRole('dialog').filter({
      has: winA!.getByRole('radiogroup', { name: '创建模式' }),
    });
    await expect(dlg).toBeVisible();
    await dlg.getByLabel('标题*').fill(HITL_TASK_TITLE);
    await dlg.getByRole('radio', { name: '组内调度' }).click();
    // A 在两组（场景2 分发组 + HITL 组）——radio 默认选首组，显式切到 HITL 组
    //（B 只入该组；pickWorker 候选 = 在线 ∧ 已镜像）
    await dlg.getByLabel('工作组').selectOption({ label: 'e2e HITL 组' });
    await dlg.getByRole('button', { name: '创建任务', exact: true }).click();
    await expect(dlg).toBeHidden({ timeout: 30000 });
    await winA!.keyboard.press('Escape');
    await expect(winA!.getByRole('dialog', { name: '任务详情' })).toBeHidden({ timeout: 10000 });

    // 委派记账 + B 真实收派首拍（task.assigned → 委派会话建立 → 回合启动 → running 上报）
    await expect
      .poll(() => hub.delegations.size, { timeout: 30000, intervals: [1000], message: 'mock hub 应收到 task.delegate' })
      .toBeGreaterThan(0);
    const hitlTaskId = [...hub.delegations.keys()].at(-1)!;
    hitl7TaskId = hitlTaskId;
    await expect
      .poll(() => (hub.taskReports.get(hitlTaskId) ?? []).length, {
        timeout: 180_000, intervals: [1500], message: 'B 侧应上报首拍 running（真实收派链）',
      })
      .toBeGreaterThan(0);

    // B 侧触达深度复核：真实委派记录在场（delegation store 落行，state=running）
    const bReceived = await winBHitl!.evaluate(async (taskId) => {
      const w = window as unknown as {
        api: { hub: { delegationBoard(): Promise<{ received: Array<{ taskId: string; state: string }> }> } };
      };
      const board = await w.api.hub.delegationBoard();
      return board.received.find((r) => r.taskId === taskId) ?? null;
    }, hitlTaskId);
    expect(bReceived?.state, 'B 侧委派记录应为 running（真实收派链触达）').toBe('running');

    // waiting 拍合成（mock 边界①）→ A 委派卡「等待节点确认」
    expect(hubPushWaitingProgress(hitlTaskId), 'waiting 拍应送达 leader A').toBe(true);
    const card = winA!.locator('button').filter({ hasText: HITL_TASK_TITLE }).first();
    await expect(card.getByText('等待节点确认')).toBeVisible({ timeout: 20000 });

    // 门控链全开（hubProtoVer 1.5.0 + waiting + leader 视角）→ 右键「批准节点写入」两段确认
    await card.click({ button: 'right' });
    await winA!.getByTestId('approve-arm').click();
    await winA!.getByTestId('approve-confirm').click();

    // toast 人话 + answered 事件回卡留痕 + hub 侧 task.answer 收包对账
    await expect(winA!.getByTestId('ui-toast')).toContainText('已远程批准', { timeout: 15000 });
    await expect(card.getByText('已远程批准')).toBeVisible({ timeout: 15000 });
    expect(hub.answerRequests.some((r) => r.taskId === hitlTaskId && r.decision === 'approve')).toBe(true);
  });

  test('场景8 版本门控负例：hello 1.2.0 → 同构 waiting 卡右键无代答菜单项', async () => {
    test.setTimeout(300_000);

    // 低版本节点 C（hello 回 1.2.0——major 同可连接，已连接态可达）
    appC = await launchApp(userC);
    const winC = await appC.firstWindow();
    await winC.waitForLoadState('domcontentloaded');
    await winC.getByRole('button', { name: '跳过引导' }).click({ timeout: 15000 });
    await winC.getByLabel('名称').fill(HITL_WS_NAME);
    await winC.getByPlaceholder('选择或输入目录路径').fill(path.join(tmpRoot, 'ws-c'));
    await winC.getByRole('button', { name: '创建', exact: true }).click();
    await expect(winC.getByRole('heading', { name: '新建工作空间' })).toBeHidden({ timeout: 15000 });
    await enrollViaSettings(winC, LOW_NODE_NAME);

    // C 建组（C 无组空态：创建表单直接展开——同 B 入组，折叠入口仅已有组渲染）
    // + 合成镜像登记（pickWorker 候选=C 自身——负例无 worker 参与，
    // mock 对低版本 leader 的 task.delegate 不下发 task.assigned）
    await winC.getByRole('button', { name: '工作组', exact: true }).click();
    await winC.getByLabel('组名').fill('e2e 低版本组');
    await winC.getByRole('button', { name: '创建', exact: true }).click();
    await expect(winC.getByText('e2e 低版本组').first()).toBeVisible({ timeout: 15000 });
    const nodeC = await waitForNodeConn(LOW_NODE_NAME);
    const lowGroup = hub.groups[hub.groups.length - 1]!;
    hubBroadcastMirrored({
      groupId: lowGroup.groupId, targetNodeId: nodeC, workspaceName: HITL_WS_NAME, snapshotId: 'snap-e2e-low',
    });

    // C 委派（组内调度——候选=C 自身）→ waiting 合成 → 卡等待角标在场
    await winC.getByRole('button', { name: '看板', exact: true }).click();
    await winC.getByRole('button', { name: '新建任务' }).first().click();
    const dlg = winC.getByRole('dialog').filter({
      has: winC.getByRole('radiogroup', { name: '创建模式' }),
    });
    await expect(dlg).toBeVisible();
    await dlg.getByLabel('标题*').fill(HITL_TASK_TITLE);
    await dlg.getByRole('radio', { name: '组内调度' }).click();
    await dlg.getByRole('button', { name: '创建任务', exact: true }).click();
    await expect(dlg).toBeHidden({ timeout: 30000 });
    await winC.keyboard.press('Escape');
    await expect(winC.getByRole('dialog', { name: '任务详情' })).toBeHidden({ timeout: 10000 });

    const lowTaskId = [...hub.delegations.keys()].at(-1)!;
    expect(lowTaskId, 'C 的委派应是新记账（区别于场景7）').not.toBe(hitl7TaskId);
    expect(hubPushWaitingProgress(lowTaskId), 'waiting 拍应送达 C').toBe(true);
    const card = winC.locator('button').filter({ hasText: HITL_TASK_TITLE }).first();
    await expect(card.getByText('等待节点确认')).toBeVisible({ timeout: 20000 });

    // 负例断言：waiting 在场（正控）+ 右键菜单打开（取消任务在场）但无代答双项
    // （hubSupportsMinor('1.2.0', 3) false——canAnswer 门控关，菜单不出现）
    await card.click({ button: 'right' });
    await expect(winC.getByTestId('cancel-arm')).toBeVisible({ timeout: 10000 });
    await expect(winC.getByTestId('approve-arm'), '版本过低不应出现「批准节点写入」').toHaveCount(0);
    await expect(winC.getByTestId('deny-arm'), '版本过低不应出现「拒绝节点写入」').toHaveCount(0);
  });

  // ── M5.0 X2（spec 2026-10-30 §7）：归属全链——发布认领 → 他节点 403 人话 +
  //    发布钮收敛 → 原主新版 → 「已发布」徽标 → own 行免装 → 安装冲突拦截 ──
  test('场景9 归属全链：认领 → B 403/钮收敛 → A 新版+徽标 → own 行免装 → B 装被拦', async () => {
    test.setTimeout(300_000);
    expect(winA, '依赖场景1的实例 A').not.toBeNull();
    expect(winBHitl, '依赖场景3的实例 B').not.toBeNull();
    const OWN_SLUG = 'e2e-own-skill';

    // A 种 custom skill 并发布 v1.0.0（首发认领——mock hub 记 owner=A）
    await winA!.evaluate(async (skillName) => {
      const w = window as unknown as {
        api: { resource: { createSkill(input: { name: string; description: string; body: string }): Promise<unknown> } };
      };
      await w.api.resource.createSkill({
        name: skillName,
        description: 'M5.0 归属 e2e fixture',
        body: '# own skill\n归属全链回归。',
      });
    }, OWN_SLUG);
    await winA!.getByRole('button', { name: '资源库', exact: true }).click();
    await winA!.getByRole('button', { name: 'Skill', exact: true }).click();
    await winA!.getByTestId(`resource-card-custom-skill-${OWN_SLUG}`).getByRole('button', { name: '发布到 hub' }).click();
    const pubDlgA = winA!.getByRole('dialog');
    await pubDlgA.getByLabel('版本').fill('1.0.0');
    await pubDlgA.getByRole('button', { name: '发布', exact: true }).click();
    await expect(pubDlgA.getByText('已发布 v1.0.0')).toBeVisible({ timeout: 30000 });
    await pubDlgA.getByRole('button', { name: '关闭' }).click();

    // mock hub 领地面：条目 ownerNodeId = A 的 nodeId（首发认领）
    const nodeA = await waitForNodeConn('e2e-node-a');
    expect(hub.resources.get(OWN_SLUG)?.ownerNodeId).toBe(nodeA);

    // B 种同 slug custom skill（本地实体在场——安装冲突拦截的靶）
    await winBHitl!.evaluate(async (skillName) => {
      const w = window as unknown as {
        api: { resource: { createSkill(input: { name: string; description: string; body: string }): Promise<unknown> } };
      };
      await w.api.resource.createSkill({
        name: skillName,
        description: 'B 侧同名 skill（归属 403 + 冲突拦截 fixture）',
        body: '# b side\n同名本地版本。',
      });
    }, OWN_SLUG);

    // B 面收敛：归属快照携 owner=A ≠ B → custom 卡「发布到 hub」不渲染（§7.4）
    await winBHitl!.getByRole('button', { name: '资源库', exact: true }).click();
    // B 首次进资源库（冷挂载）——Skill 点击可能在侧栏重挂载窗口丢失，heading 门 + 重试自愈
    await expect(async () => {
      const heading = winBHitl!.getByRole('heading', { name: '技能' });
      if (await heading.isVisible().catch(() => false)) return;
      await winBHitl!.getByRole('button', { name: 'Skill', exact: true }).click();
      await expect(heading).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 30000 });
    const bCard = winBHitl!.getByTestId(`resource-card-custom-skill-${OWN_SLUG}`);
    await expect(bCard).toBeVisible({ timeout: 20000 });
    await expect(bCard.getByRole('button', { name: '发布到 hub' }), '非 owner 发布钮应收敛不渲染').toHaveCount(0);

    // B 直连发布（防御层——旧客户端/直连 API 面）：403 not_owner 人话（§7.2）
    const bErr = await winBHitl!.evaluate(async ([skillName]) => {
      const w = window as unknown as {
        api: { hub: { publishResource(input: { type: 'skill'; ref: string; meta?: { version?: string } }): Promise<unknown> } };
      };
      try {
        await w.api.hub.publishResource({ type: 'skill', ref: skillName, meta: { version: '9.9.9' } });
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }, [OWN_SLUG] as const);
    expect(bErr).toContain('该资源属于节点 e2e-node-a，无法发布新版');
    // 领地未被越权写破：9.9.9 不存在，latest 仍 1.0.0
    expect(hub.resources.get(OWN_SLUG)?.versions.has('9.9.9')).toBe(false);

    // A 原主发新版 v1.1.0（owner 放行）→ A custom 卡「已发布」徽标（§7.1）
    await winA!.getByTestId(`resource-card-custom-skill-${OWN_SLUG}`).getByRole('button', { name: '发布到 hub' }).click();
    const pubDlgA2 = winA!.getByRole('dialog');
    await pubDlgA2.getByLabel('版本').fill('1.1.0');
    await pubDlgA2.getByRole('button', { name: '发布', exact: true }).click();
    await expect(pubDlgA2.getByText('已发布 v1.1.0')).toBeVisible({ timeout: 30000 });
    await pubDlgA2.getByRole('button', { name: '关闭' }).click();
    const aCard = winA!.getByTestId(`resource-card-custom-skill-${OWN_SLUG}`);
    await expect(aCard.getByTestId('hub-published-badge')).toBeVisible({ timeout: 20000 });
    await expect(aCard.getByTestId('hub-published-badge')).toContainText('已发布 v1.1.0 → momo-hub');

    // A own 行免装（§7.5①）：获取弹窗行改显「你的发布 · 本地 v… · 已发布 v…」
    await winA!.getByRole('button', { name: '添加技能' }).click();
    await winA!.locator('[role="menu"]').getByText('从 momo-hub 获取…').click();
    const fetchDlgA = winA!.getByRole('dialog', { name: '从 momo-hub 获取技能' });
    const ownRow = fetchDlgA.getByTestId(`fetch-row-hub-skill-${OWN_SLUG}`);
    await expect(ownRow).toBeVisible({ timeout: 20000 });
    await expect(ownRow.getByTestId('fetch-own-publish')).toContainText('你的发布');
    await expect(ownRow.getByTestId('fetch-own-publish')).toContainText('已发布 v1.1.0');
    await expect(ownRow.getByRole('button', { name: '安装', exact: true }), 'own 行不得渲染安装钮').toHaveCount(0);
    await fetchDlgA.getByRole('button', { name: '关闭' }).click();
    await expect(fetchDlgA).toBeHidden();

    // B 安装冲突拦截（§7.5②）：本地 custom 实体在场 → 拒装人话
    await winBHitl!.getByRole('button', { name: '添加技能' }).click();
    await winBHitl!.locator('[role="menu"]').getByText('从 momo-hub 获取…').click();
    const fetchDlgB = winBHitl!.getByRole('dialog', { name: '从 momo-hub 获取技能' });
    const bRow = fetchDlgB.getByTestId(`fetch-row-hub-skill-${OWN_SLUG}`);
    await expect(bRow).toBeVisible({ timeout: 20000 });
    await bRow.getByRole('button', { name: '安装', exact: true }).click();
    await expect(fetchDlgB.getByText(/本地已有同名自定义资源/)).toBeVisible({ timeout: 30000 });
    // 拦截面：零下载（未进下载链）
    expect(downloadCount(OWN_SLUG, '1.1.0'), '冲突拦截不得产生下载').toBe(0);
    await fetchDlgB.getByRole('button', { name: '关闭' }).click();
    await expect(fetchDlgB).toBeHidden();
  });

  // M5.1 追加（spec 2026-10-30 §1.1/§1.3——插件×本地副本去重）：
  //   11. 导入拦截：dev 插件提供技能 e2e-dup-skill → zip 导入同名 → 拒 +
  //      人话「插件 … 已提供技能 …，无需导入副本」零写入
  //   12. 提示条→清理：custom 副本（createSkill 造成——spec 拦截面只含 zip 导入）
  //      → Skill 页提示条「检测到 1 个」→ 一键清理 → 提示条消失 + custom 卡
  //      不输出（归并）+ 插件卡保留 + 重复清单空
  test('场景11+12 M5.1 插件重复：zip 导入拒 + 提示条一键清理', async () => {
    test.setTimeout(240_000);
    expect(winA, '依赖场景1的实例 A').not.toBeNull();

    const PLUGIN_ID = 'e2e-dup-plugin';
    const DUP_SLUG = 'e2e-dup-skill';

    // fixture：dev 插件（提供同名技能）+ custom 本地副本（表单创建路径）
    const pluginDir = path.join(tmpRoot, 'dup-plugin');
    fs.mkdirSync(path.join(pluginDir, 'skills', DUP_SLUG), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'skills', DUP_SLUG, 'SKILL.md'),
      `---\nname: ${DUP_SLUG}\ndescription: 插件技能\n---\n\n插件正文。\n`,
    );
    fs.writeFileSync(
      path.join(pluginDir, 'momo-plugin.json'),
      JSON.stringify({
        id: PLUGIN_ID, name: PLUGIN_ID, version: '1.0.0',
        description: 'M5.1 e2e dedup fixture', components: { skills: './skills' },
      }),
    );
    await winA!.evaluate(async ([dir, skillName]) => {
      const w = window as unknown as {
        api: {
          plugin: { installDevDir(d: string): Promise<unknown> };
          resource: {
            createSkill(input: { name: string; description: string; body: string }): Promise<unknown>;
          };
        };
      };
      await w.api.plugin.installDevDir(dir);
      await w.api.resource.createSkill({
        name: skillName, description: '重复本地副本', body: '# dup\n本地副本正文。',
      });
    }, [pluginDir, DUP_SLUG] as const);

    // ── 场景11：zip 导入遇插件同名 → 拒 + 人话（UploadSkillDialog 红字直出）──
    const AdmZipCtor = electronRequire('adm-zip') as new () => {
      addFile(name: string, data: Buffer): void;
      toBuffer(): Buffer;
    };
    const zip = new AdmZipCtor();
    zip.addFile(`${DUP_SLUG}/SKILL.md`, Buffer.from(`---\nname: ${DUP_SLUG}\ndescription: dup\n---\n# dup\n`));
    const zipPath = path.join(tmpRoot, `${DUP_SLUG}.zip`);
    fs.writeFileSync(zipPath, zip.toBuffer());

    await winA!.getByRole('button', { name: '资源库', exact: true }).click();
    await winA!.getByRole('button', { name: 'Skill', exact: true }).click();
    await winA!.getByRole('button', { name: '添加技能' }).click();
    await winA!.locator('[role="menu"]').getByText('导入 zip 包…').click();
    const upDlg = winA!.getByRole('dialog', { name: '上传自定义 Skill' });
    await upDlg.locator('input[aria-label="选择文件"]').setInputFiles(zipPath);
    await upDlg.getByRole('button', { name: '上传', exact: true }).click();
    await expect(upDlg.getByText(`插件 ${PLUGIN_ID} 已提供技能 ${DUP_SLUG}，无需导入副本`)).toBeVisible({
      timeout: 15000,
    });
    await upDlg.getByRole('button', { name: '取消' }).click();
    await expect(upDlg).toBeHidden();

    // ── 场景12：提示条 → 一键清理 → custom 卡不输出（归并）+ 插件卡保留 ──
    // 切页重进触发 load + pluginDupScan（store 刷新沿页面生命周期）。「智能体」
    // 与活动栏视图钮同名——getByLabel('资源类型') nav 收窄到库页侧栏
    const typeNav = winA!.getByLabel('资源类型');
    await typeNav.getByRole('button', { name: '智能体' }).click();
    await typeNav.getByRole('button', { name: 'Skill' }).click();
    const banner = winA!.getByTestId('plugin-dup-banner');
    await expect(banner).toBeVisible({ timeout: 20000 });
    await expect(banner.getByText('检测到 1 个与插件重复的本地副本')).toBeVisible();
    // 归并面：插件卡在场，custom 副本卡不输出（隐藏非删除）
    const pluginCard = winA!.getByTestId(`resource-card-plugin-skill-${DUP_SLUG}`);
    await expect(pluginCard).toBeVisible({ timeout: 20000 });
    await expect(winA!.getByTestId(`resource-card-custom-skill-${DUP_SLUG}`)).toHaveCount(0);

    await banner.getByRole('button', { name: '一键清理' }).click();
    await expect(banner).toBeHidden({ timeout: 20000 });
    await expect(pluginCard, '清理后插件卡保留').toBeVisible();
    await expect(winA!.getByText(/已清理 1 个与插件重复的本地副本/)).toBeVisible();

    // 结构化复核：custom 源无该 slug（副本已删）+ 重复清单空（提示条不回弹）
    const after = await winA!.evaluate(async ([skillName]) => {
      const w = window as unknown as {
        api: {
          resource: {
            list(filter: { type: string; source: string }): Promise<Array<{ slug: string }>>;
            pluginDupScan(): Promise<Array<{ slug: string }>>;
          };
        };
      };
      const customs = await w.api.resource.list({ type: 'skill', source: 'custom' });
      return {
        hasCustom: customs.some((i) => i.slug === skillName),
        dups: await w.api.resource.pluginDupScan(),
      };
    }, [DUP_SLUG] as const);
    expect(after.hasCustom, 'custom 副本应已删除').toBe(false);
    expect(after.dups).toEqual([]);
  });
});
