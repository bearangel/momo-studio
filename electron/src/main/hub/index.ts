// HubManager 单例——主进程生命周期接线（taskExecutor 同款模块级单例模式）。
// 职责：读配置+凭证 → 起停 HubClient；状态/事件转发全部窗口（webContents.send）。
// 禁止顶层 import 'electron'（2026-11-13 实机 P0）：本文件在 runtime 子进程静态图内
// （runtime-entry → … → resource/hub/momo-hub → hub/index），而打包产物 asar 里没有
// electron npm 包——顶层 import 会让子进程 boot 即 MODULE_NOT_FOUND（exit 1），
// WarmPool 预热全灭、agent 恒不回复。统一经 electron-access 惰性取用 + 不可用降级。
import { loadElectronApis } from '../electron-access';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { createHubClient, enrollOverHttp, type HubClient, type HubConnectionState } from './client';
import { createHubConfigStore, type HubConfigRow } from './config-store';
import {
  clearDeviceToken,
  getDeviceToken,
  setDeviceToken,
} from './creds';
import {
  registerTrustedDownloadOrigin,
  unregisterTrustedDownloadOrigin,
} from '../marketplace/installer';
import {
  applyHubPublishedEventToCatalog,
  applyHubUnpublishedEventToCatalog,
} from '../resource/hub/momo-hub';
import { EVT, type EventEnvelope, type RequestEnvelope, type ResponseEnvelope, type RpcErrorPayload } from './protocol';
import { MIRROR_WIRE, type MirrorApplyPayload, type MirrorApplyOutcome } from './mirror-wire';
import { applyMirrorSnapshot } from './mirror-applier';
import { bridgeGroupChanged, createGroupClient } from './groups';
import type { HubResponderResult } from './client';
import { createDelegationRunner, type AssignedTaskEvent, type DelegationRunner } from './delegation-runner';
import { sessionWaitingProduct, wireDelegationRunnerPorts } from './delegation-ports';
import { TASK_ANSWER_WIRE } from './delegation-wire';
import { handleTaskAnswerRequest, type TaskAnswerPorts } from './delegation-answer';
import { grantWriteDirs } from '../sandbox/write-grant';
import { clearPendingOnDeny, clearPendingOnGrant, listPendingWriteBlocked } from '../sandbox/write-blocked-emit';
import { broadcastWriteGrantDenied } from '../agent/runtime-registry';
import { createHubDelegationSettingsStore, type HubDelegationSettings } from './delegation-settings';
import { createHubWorkspaceDirStore, type HubWorkspaceDirView } from './workspace-dir-settings';
import { createHubDelegationStore, type DelegationRecord } from './delegation-store';
import {
  createDelegationProgressStore,
  createDelegationSync,
  type DelegationProgressEntry,
  type DelegationSync,
} from './delegation-sync';
import { listWorkspaces } from '../workspace/crud';
import { insertTask, updateTask, getTask, listTasks } from '../storage/tasks/repo';
import { getActiveRun } from '../storage/tasks/runs-repo';
import { acceptTask, setRemoteInterveneSink } from '../task/lifecycle-runs';
import { setToolGateRowSink } from '../sandbox/write-blocked-emit';
import {
  createRemoteInterveneHandler,
  handleInterventionAnswered,
  handleTaskAccepted,
  handleTaskInterventionMirror,
  handleTaskRejected,
  handleTaskSubmittedMirror,
  type WorkerTerminalConsumePorts,
} from './remote-intervene-bridge';
import { isTerminal } from '../storage/tasks/state-machine';
import { reconcileOnReconnect } from './reconnect-reconcile';
import { createMirrorRegistry, type MirrorRegistryRow } from './mirror-registry';
import { ViewServer } from './view-server';
import { createHubViewSettingsStore, type HubViewSettings } from './view-settings';
import { VIEW_WIRE } from './view-wire';
import { VIEW_RPC } from './protocol';
import { isPermissionTier } from './run-policy';
import { backfillTrackingSessions } from './tracking-session';

export interface HubStatus {
  configured: boolean;
  state: HubConnectionState;
  hubUrl: string | null;
  nodeName: string | null;
  nodeId: string | null;
  lastError: string | null;
  /** 最近一次连接错误的协议错误码（M3.0-P2，如 proto_version_mismatch）；无错误为 null */
  lastErrorCode: string | null;
  /** 当前连接协商到的 hub 协议版本（M3.0-P2，hello 应答 protoVer）；未连接为 null */
  hubProtoVer: string | null;
}

let client: HubClient | null = null;
let lastError: string | null = null;
// 最近一次连接错误的协议错误码——与 lastError 同生命周期（online/forget/换址清零）
let lastErrorCode: string | null = null;
// 当前连接的在线节点快照（hello 成功时写入，已排除本机）——renderer 拉状态时重播，
// 使「面板挂载晚于 hello」也见全量在线节点（快照是 hub 唯一的存量下发面：
// 协议 onlineNodes 注释明言「后续增量走 node.online/offline 事件」）。
// 集合由快照（存量）+ node.online/offline 事件（增量）共同维护——重播的是权威视图
let presenceSeed: Array<{ nodeId: string; nodeName: string }> | null = null;

const configStore = () => createHubConfigStore(getDb());
const delegationSettingsStore = () => createHubDelegationSettingsStore(getDb());
const viewSettingsStore = () => createHubViewSettingsStore(getDb());
const workspaceDirStore = () => createHubWorkspaceDirStore(getDb());
const mirrorRegistry = () => createMirrorRegistry(getDb());
// 发起方对账用组客户端（S6 跟踪会话回填——目标节点名解析；复用 hubRequest 关联器）
const originGroupsClient = createGroupClient((method, payload, timeoutMs) =>
  hubRequest(method, payload, timeoutMs),
);

/**
 * S9（A4 工作站段）镜像行 remote 段数据源：执行节点 → 组清单成员
 * boundWorkspaceName（仅 peer 组投影携带；lf 组缺席 → null 降级仅节点名）。
 * 镜像事件低频（干预/提交），逐事件直拉不设缓存；hub 不可达 → null 不阻断镜像。
 */
const mirrorWorkstationOf = async (nodeId: string): Promise<string | null> => {
  try {
    const { groups } = await originGroupsClient.list();
    for (const g of groups) {
      const m = g.members.find((x) => x.nodeId === nodeId);
      if (m !== undefined && typeof m.boundWorkspaceName === 'string') {
        return m.boundWorkspaceName;
      }
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * 镜像登记表查询面（IPC hub:mirrorRegistry 消费；RM-M21-7 四消费方同源：
 * T3 节点卡徽标 / T4 查看选择器 / T7 调度器 mirroredBy / T8 新建弹窗守门）。
 *
 * 失忆限制（M2 协议无重放/无查询 RPC）：登记表只累积本机在线期间收到的
 * workspace.mirrored 组内广播——晚入组 / 离线期间发生的镜像不可恢复，
 * 重启前已镜像节点若无新事件不自动回表；M3 以 hub 查询式清单 RPC 补齐。
 */
export function hubListMirrorRegistry(workspaceName?: string): MirrorRegistryRow[] {
  return mirrorRegistry().list(workspaceName);
}

/** 委派设置面（IPC 消费——开关/并发上限即时生效：runner 每次读取现值） */
export function hubGetDelegationSettings(): HubDelegationSettings {
  return delegationSettingsStore().read();
}

export function hubSetDelegationSettings(input: HubDelegationSettings): HubDelegationSettings {
  return delegationSettingsStore().write(input);
}

/** 工作目录面（IPC 消费——节点互联「工作目录」；镜像落位与新建预填共用 effectiveRootDir）。 */
export function hubGetWorkspaceDirSettings(): HubWorkspaceDirView {
  return workspaceDirStore().view();
}

export function hubSetWorkspaceDirSettings(input: { rootDir: string | null }): HubWorkspaceDirView {
  return workspaceDirStore().write(input);
}

/** 查看同意设置面（IPC 消费——「允许本组查看」开关，默认 true）。 */
export function hubGetViewSettings(): HubViewSettings {
  return viewSettingsStore().read();
}

export function hubSetViewSettings(input: HubViewSettings): HubViewSettings {
  const normalized = viewSettingsStore().write(input);
  // 变更即时上报（spec §5.5：节点上线时上报 + 变更即时上报）——离线时跳过，
  // 重连由 onStateChange(online) 的重报链兜底（RM2-9 断线清除回默认 + 重报覆盖）
  void reportViewConsent();
  return normalized;
}

// 委派执行器模块级单例（taskExecutor 同款模式）：与连接生命周期解耦——
// 连接重建（换址/重接入）不改 runner（本地委派账本跨连接存续，重连对账续传）。
let delegationRunner: DelegationRunner | null = null;

// 外派投影状态回写（M2.1 T9 delegation-sync）模块级单例：leader 侧四推送 +
// task.cancel 回执 → tasks 行六态映射；worker 侧 delegation store 装饰（收委派
// 建行）。与 runner 同生命周期（DB/kv 边界，连接重建不换实例）。
let delegationSync: DelegationSync | null = null;

function ensureDelegationSync(): DelegationSync {
  if (delegationSync) return delegationSync;
  const raw = createDelegationSync({
    findTaskByDelegation: (delegationId) => {
      const db = getDb();
      const row = db
        .prepare('SELECT id FROM tasks WHERE delegation_id = ?')
        .get(delegationId) as { id: string } | undefined;
      return row ? (getTask(row.id) ?? null) : null;
    },
    updateTask: (id, patch) => {
      updateTask(id, patch);
    },
    saveProgress: (delegationId, entry) => {
      createDelegationProgressStore(getDb()).save(delegationId, entry);
    },
    getProgress: (delegationId) => createDelegationProgressStore(getDb()).get(delegationId),
    insertWorkerTaskRow: (input) =>
      insertTask({
        workspaceId: input.workspaceId,
        title: input.title,
        creatorUserId: 'owner',
        status: input.status,
        routing: input.routing,
        delegationId: input.delegationId,
        startedAt: input.startedAt,
      }).id,
    findWorkspaceByName: (name) => {
      const ws = listWorkspaces().find((w) => w.name === name);
      return ws ? { id: ws.id } : null;
    },
    selfNodeId: () => configStore().read()?.nodeId ?? null,
    // S8 版本门 worker 侧判据（连接随 hubConfigure/Forget 重建——惰性读当前连接）
    hubProtoVer: () => hubProtoVer(),
    now: () => Date.now(),
  });
  // 投影回写是辅助面：DB 异常不得断掉事件桥（renderer 广播与 hub 账本主链
  // 不受影响；warn 留痕——非吞状态，行对账由下一次事件/轮询兜底）
  const guard = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      logger.warn(`外派投影回写失败（${label}）`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  delegationSync = {
    handleProgress: (evt) => guard('progress', () => raw.handleProgress(evt)),
    handleTerminal: (status, taskId, reason) => guard('terminal', () => raw.handleTerminal(status, taskId, reason)),
    markCancelled: (taskId) => guard('cancelled', () => raw.markCancelled(taskId)),
    handleAnswered: (evt) => guard('answered', () => raw.handleAnswered(evt)),
    wrapWorkerStore: (store) => raw.wrapWorkerStore(store),
  };
  return delegationSync;
}

/**
 * 看板外派投影引导读（IPC hub:delegationBoard 消费）：
 *   - progress：进度摘要 kv 全量（delegationId → excerpt——重启后进度行不丢）
 *   - received：worker 侧本地委派记录（byNode=来源——「来自 {node}」徽标数据源）
 * kv/store 皆按需新开实例读同一份数据（无内存态，幂等安全）。
 */
export function hubDelegationBoard(): {
  progress: Record<string, DelegationProgressEntry>;
  received: DelegationRecord[];
} {
  return {
    progress: createDelegationProgressStore(getDb()).list(),
    received: createHubDelegationStore(getDb()).list(),
  };
}

/**
 * 本机等待确认的委派会话清单（IPC hub:localWaiting，M2.1 T12 worker 侧等待卡）：
 * running 委派账本 × sessionWaitingProduct（T11 同一真源与门控——write-blocked
 * 未决登记 + streaming 门控），等待中的会话 → { sessionId, summary }。恢复
 * （grant/deny 处置）即从登记面清除，下次拉取自动去态。
 */
export function hubLocalWaiting(): Array<{ sessionId: string; summary: string }> {
  const out: Array<{ sessionId: string; summary: string }> = [];
  for (const record of createHubDelegationStore(getDb()).list()) {
    if (record.state !== 'running') continue;
    const waiting = sessionWaitingProduct(record.sessionId);
    if (waiting.waiting) out.push({ sessionId: record.sessionId, summary: waiting.summary });
  }
  return out;
}

/** task.cancel 回执 → 外派行 cancelled 同步（IPC hub:taskCancel 成功路径消费） */
export function hubMarkDelegationCancelled(taskId: string): void {
  ensureDelegationSync().markCancelled(taskId);
}

// 远程查看服务端模块级单例（同款模式）：连接经 clientGetter 惰性取用，
// 连接重建不换实例（订阅登记跨连接存续，hub 侧订阅在目标断开时已注销——
// leader 重订阅走全新 view.subscribe 转发，无陈旧登记复活面）。
let viewServer: ViewServer | null = null;

function ensureViewServer(): ViewServer {
  if (viewServer) return viewServer;
  viewServer = new ViewServer({
    clientGetter: () => client,
    settings: () => viewSettingsStore().read(),
  });
  return viewServer;
}

/** view.consent 上行（hello 后/重连/开关变更三入口共用）——非 online 静默跳过。 */
function reportViewConsent(): Promise<void> {
  if (!client || client.state() !== 'online') return Promise.resolve();
  const allowed = viewSettingsStore().read().allowGroupView;
  return client
    .request(VIEW_WIRE.consent, { allowed })
    .then(() => {
      logger.info('查看开关已上报', { allowed });
    })
    .catch((err) => {
      logger.warn('查看开关上报失败（重连时重报兜底）', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/** 委派执行器懒构造（首次收到 task.assigned / 重连恢复时需要） */
function ensureDelegationRunner(nodeId: string | null): DelegationRunner {
  if (delegationRunner) return delegationRunner;
  delegationRunner = createDelegationRunner({
    ports: wireDelegationRunnerPorts({
      clientGetter: () => client,
      selfNodeId: () => configStore().read()?.nodeId ?? nodeId,
      settings: () => delegationSettingsStore().read(),
    }),
    // T9 外派投影：装饰 store 观察收委派建行 / 本地四态同步（runner 本体零改）
    store: ensureDelegationSync().wrapWorkerStore(createHubDelegationStore(getDb())),
  });
  return delegationRunner;
}

/**
 * 派单载荷挑字段（协议 TaskAssignedEvent 形状，异形键丢弃——与 presence 桥同款纪律）。
 * export 仅供测试锚定（tests/hub/manager.test.ts parseTaskAssigned 面——M4.3
 * dependsOn 剥除的运行时锁），生产调用方仍限本模块 startClient。
 */
export function parseTaskAssigned(payload: unknown): AssignedTaskEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as {
    taskId?: unknown; workspaceName?: unknown; byNode?: unknown; task?: unknown; groupId?: unknown;
  };
  const t = p.task as
    | { title?: unknown; prompt?: unknown; agentSlug?: unknown; permissionTier?: unknown; team?: unknown; draft?: unknown; priority?: unknown }
    | undefined;
  if (typeof p.taskId !== 'string' || typeof p.workspaceName !== 'string' || typeof p.byNode !== 'string') return null;
  if (!t || typeof t.title !== 'string' || typeof t.prompt !== 'string') return null;
  return {
    taskId: p.taskId,
    workspaceName: p.workspaceName,
    byNode: p.byNode,
    task: {
      title: t.title,
      prompt: t.prompt,
      ...(typeof t.agentSlug === 'string' ? { agentSlug: t.agentSlug } : {}),
      // T10 协议未知容忍：hub 1.2.0 剥离 permissionTier（白名单重建），合法值才拾取
      // （normalizeTier 兜底收敛 confirm）；hub 升级透传后直接消费。
      ...(isPermissionTier(t.permissionTier) ? { permissionTier: t.permissionTier } : {}),
      // M5.3（1.9.0）：team 段形状合法才透传（hub 侧已按 2..8 名/恰一 leader 校验）；
      // 形态非法（深度防御面：异构 hub/损坏载荷）不再回落单 agent——回落=静默换班，
      // 打 teamInvalid 标记交 runner decline（dependsOn 刻意不透传：worker 零消费）
      ...(isDelegationTeam(t.team) ? { team: t.team } : {}),
      ...(t.team !== undefined && !isDelegationTeam(t.team) ? { teamInvalid: true } : {}),
      // 1.10.0（协议 1.10.0）：draft/priority 容错透传（draft 字面 true；priority
      // 0..10 整数——hub 已闸，异形值剥除不抛）；groupId 组归属（绑定解析键）
      ...(t.draft === true ? { draft: true as const } : {}),
      ...(typeof t.priority === 'number' && Number.isInteger(t.priority) && t.priority >= 0 && t.priority <= 10
        ? { priority: t.priority }
        : {}),
    },
    ...(typeof p.groupId === 'string' && p.groupId.length > 0 ? { groupId: p.groupId } : {}),
  };
}

/** team 段形状守卫：members 数组且每项 { name: string; isLeader: boolean } */
function isDelegationTeam(raw: unknown): raw is { members: Array<{ name: string; isLeader: boolean }> } {
  if (typeof raw !== 'object' || raw === null) return false;
  const members = (raw as { members?: unknown }).members;
  if (!Array.isArray(members) || members.length === 0) return false;
  return members.every(
    (m) =>
      typeof m === 'object' && m !== null &&
      typeof (m as { name?: unknown }).name === 'string' && (m as { name: string }).name.length > 0 &&
      typeof (m as { isLeader?: unknown }).isLeader === 'boolean',
  );
}

function broadcast(channel: string, payload: unknown): void {
  // 子进程内（无 electron API）降级为 no-op：广播只是 UI 刷新，绝不因取不到窗口抛错
  const { BrowserWindow } = loadElectronApis();
  if (!BrowserWindow) return;
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

export function hubGetStatus(): HubStatus {
  const cfg = configStore().read();
  return {
    configured: cfg !== null,
    state: client?.state() ?? 'disconnected',
    hubUrl: cfg?.hubUrl ?? null,
    nodeName: cfg?.nodeName ?? null,
    nodeId: cfg?.nodeId ?? null,
    lastError,
    lastErrorCode,
    hubProtoVer: client?.hubProtoVer() ?? null,
  };
}

/**
 * 当前连接协商到的 hub 协议版本直读（M3.0-P2 版本管道；未连接为 null）。
 * M5.3 团队派发 hub 闸数据源（dispatch-submit——静默换班第 4 处闭合）。
 */
export function hubProtoVer(): string | null {
  return client?.hubProtoVer() ?? null;
}

/**
 * 节点清单补拉（A6）：面板冷启动/重挂载时一次性取回权威在线集合。
 * presenceSeed 本就剔除本机（renderer 自合成本机行；重复播会双行）——本机行在此拼回。
 * 只读主进程内存状态：不发 hub RPC、不改协议；快照过期语义随 presenceSeed 走
 * （掉线/换址/忘记均置 null，故此时只余本机行或空）。
 */
export function hubGetPresenceNodes(): Array<{ nodeId: string; nodeName: string; at?: number }> {
  const status = hubGetStatus();
  return [
    ...(status.nodeId !== null ? [{ nodeId: status.nodeId, nodeName: status.nodeName ?? '' }] : []),
    ...(presenceSeed ?? []),
  ];
}

/**
 * RPC 请求面（M2 组管理消费）——透传 client 关联器；未建连/未配置时人话拒绝。
 * 错误语义由 client.request 单点定义（hub 人话原文 / 连接已重置 / 超时）。
 */
export function hubRequest<T>(method: string, payload: unknown, timeoutMs?: number): Promise<T> {
  if (!client) return Promise.reject(new Error('hub 未连接，请先在设置中接入 momo-hub'));
  return client.request<T>(method, payload, timeoutMs);
}

/**
 * task.answer 生产端口（M3.1 远程代答）：本机代答原语同一 API 面——
 * sandbox:grantWrite / sandbox:denyWrite IPC 同款接线（grant/deny 原语 +
 * write-blocked-emit 登记清除 + runtime-registry deny 广播）。
 */
function taskAnswerPorts(): TaskAnswerPorts {
  return {
    findDelegationSession: (taskId) => createHubDelegationStore(getDb()).get(taskId)?.sessionId ?? null,
    listPending: (sessionId) => listPendingWriteBlocked(sessionId),
    grantDirs: (sessionId, dirs) => grantWriteDirs('session', sessionId, dirs),
    clearGranted: (sessionId, dirs) => clearPendingOnGrant('session', sessionId, dirs),
    clearDenied: (sessionId) => clearPendingOnDeny(sessionId, []),
    broadcastDenied: (dirs) => broadcastWriteGrantDenied(dirs),
    logAnswered: (info) => logger.info('远程代答处置', info),
  };
}

/**
 * mirror.apply 被动应答器（目标节点侧）：应用器 outcome → mirror.receipt res 信封
 * （id=对账键透传；conflict 附 diffSummary 超集——RpcErrorPayload + diffSummary）。
 * 未知 req 方法回 unknown_method（诚实应答优于静默——hub 侧按 id 结算不悬挂）。
 * 应用成功同时广播 workspace:listChanged（D3：镜像落地的空间对 renderer 可见——
 * workspace.store 重拉列表；session:listChanged 同款推送纪律）。
 */
async function handleHubRequest(req: RequestEnvelope): Promise<HubResponderResult> {
  if (req.method === MIRROR_WIRE.apply) {
    const payload = req.payload as MirrorApplyPayload;
    const outcome: MirrorApplyOutcome = await applyMirrorSnapshot(payload);
    if (outcome.ok) {
      broadcast('workspace:listChanged', {
        reason: 'mirror-applied',
        workspaceName: payload.workspaceName,
      });
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
      } satisfies RpcErrorPayload,
    };
  }
  // view.* 六方法（M2e T14 查看服务端）：目标节点只读组装/尾部订阅
  if ((Object.values(VIEW_RPC) as readonly string[]).includes(req.method)) {
    return ensureViewServer().handleViewRequest(req);
  }
  // task.answer 转发（M3.1 HITL L2 远程代答）：worker 侧应答——复用本机代答原语
  // 解除写授权等待（delegation-answer.ts 纯处理器 + taskAnswerPorts 生产装配）
  if (req.method === TASK_ANSWER_WIRE) {
    return handleTaskAnswerRequest(req.payload, taskAnswerPorts());
  }
  return { ok: false, payload: { code: 'unknown_method', message: `节点不支持的方法: ${req.method}` } satisfies RpcErrorPayload };
}

/**
 * mirror.result（两段式第二段，res 信封定向→本机 leader）→ hub:mirrorResult 推送。
 * 载荷挑字段（ok 成功 {appliedResources, unresolvedRefs?} / 失败 {code, message,
 * diffSummary?}），不透传整个信封防杂字段渗入 renderer 契约——与 presence 桥同款纪律。
 */
function bridgeMirrorResult(res: ResponseEnvelope, broadcast: (channel: string, payload: unknown) => void): void {
  if (res.method !== MIRROR_WIRE.result) return;
  const p = res.payload as {
    mirrorId?: unknown; appliedResources?: unknown; unresolvedRefs?: unknown;
    code?: unknown; message?: unknown; diffSummary?: unknown;
  } | null;
  if (typeof p?.mirrorId !== 'string') return; // 异形结果丢弃（hub 侧契约保证必带）
  if (res.ok) {
    broadcast('hub:mirrorResult', {
      mirrorId: p.mirrorId,
      ok: true,
      appliedResources: Array.isArray(p.appliedResources) ? p.appliedResources : [],
      ...(Array.isArray(p.unresolvedRefs) ? { unresolvedRefs: p.unresolvedRefs } : {}),
    });
    return;
  }
  broadcast('hub:mirrorResult', {
    mirrorId: p.mirrorId,
    ok: false,
    code: typeof p.code === 'string' ? p.code : 'internal',
    message: typeof p.message === 'string' ? p.message : '镜像失败',
    ...(p.diffSummary && typeof p.diffSummary === 'object' ? { diffSummary: p.diffSummary } : {}),
  });
}

function startClient(
  hubUrl: string,
  nodeName: string,
  deviceToken: string,
  nodeId: string | null,
): void {
  client?.stop();
  // 新连接开始 → 上个连接的快照作废（重播不得推陈旧节点）
  presenceSeed = null;
  client = createHubClient({
    url: wsUrlOf(hubUrl),
    nodeName,
    deviceToken,
    onStateChange(state, err, errCode) {
      if (err) lastError = err;
      if (errCode !== undefined) lastErrorCode = errCode;
      if (state === 'online') {
        lastError = null;
        lastErrorCode = null;
        // 重连恢复（T11）：中断任务对账续传 + 缓冲进度拍冲刷（fire-and-forget——
        // 状态回调不 await 恢复链，连接状态机不被对账阻塞）
        void ensureDelegationRunner(nodeId).handleOnline();
        // S7 断线对账（spec §8.6 断连窗口补偿）：错过的代答/干预/提交事件经
        // task.interventions + task.list 拉取幂等收敛；内部失败容忍，不阻塞重连链
        if (client !== null) {
          void reconcileOnReconnect({ client });
        }
        // 查看开关重报（T13 交接——RM2-9：hub 断线清除 consent 回默认 true，
        // 重连必须重报本地设置，否则关闭态节点重连后即恢复可查看）
        void reportViewConsent();
      }
      // 掉线 → 快照过期（断连期间收不到 peer 上下线事件）
      else presenceSeed = null;
      // 版本管道（M3.0-P2）：hubProtoVer 在 client 内先于 online 广播落值，
      // 此处读到的即本次协商结果；断开路径 client 已先行清 null
      broadcast('hub:stateChanged', {
        state,
        lastError,
        lastErrorCode,
        hubProtoVer: client?.hubProtoVer() ?? null,
      });
    },
    onEvent(evt: EventEnvelope) {
      if (evt.method === EVT.taskAssigned) {
        // 委派派单（M2e T10）：异形载荷丢弃（hub 侧契约保证形状，防御性挑字段）
        const assigned = parseTaskAssigned(evt.payload);
        if (assigned) void ensureDelegationRunner(nodeId).handleAssigned(assigned);
        return;
      }
      if (evt.method === EVT.taskCancelled) {
        // 取消通知（M2e T11）：定向→目标节点；运行中停跑，pending/interrupted 本地无动作
        const p = evt.payload as { taskId?: unknown };
        if (typeof p.taskId === 'string') {
          ensureDelegationRunner(nodeId).handleCancelled({ taskId: p.taskId });
        }
        return;
      }
      if (evt.method === EVT.taskInterventionAnswered) {
        // worker 侧远端代答消费（P2 S3）：hub 定向→本机 worker（interventionId =
        // 本地 human_requests.id，S2 桥约定）→ answerHuman 统一路由（三类 kind 零
        // 特判）。订阅随连接生命周期（onEvent 只在 online 后触发）——断连窗口内
        // 错过的代答无补偿（自然降级：请求行仍 pending，节点所有者可自答），重连
        // 后由 S7 对账兜底。
        handleInterventionAnswered(evt.payload);
        return;
      }
      if (evt.method === EVT.taskAccepted || evt.method === EVT.taskRejected) {
        // worker 侧验收结果消费（P2 S4）：hub 定向→本机 worker（payload.taskId =
        // hub 委派 id，桥内经 delegation_id 反查本地承接行）→ 复用
        // completeAcceptance / rejectTask 写路径落本地终态与返工 + 停靠出清。
        // 断连窗口（沿 S3 口径）：onEvent 只在 online 后触发——错过的验收结果无
        // 事件补偿（自然降级：任务保持 submitted，节点所有者可本地验收/打回），
        // 重连后由 S7 对账兜底。
        const consumePorts: WorkerTerminalConsumePorts = {
          selfNodeId: () => configStore().read()?.nodeId ?? nodeId,
          // 停靠项只存在于已创建的 runner（handleAssigned/handleOnline 建档）；
          // 无 runner = 无停靠，幂等 no-op
          settleDocked: (taskId, outcome) => {
            delegationRunner?.settleAcceptance(taskId, outcome);
          },
        };
        if (evt.method === EVT.taskAccepted) void handleTaskAccepted(evt.payload, consumePorts);
        else void handleTaskRejected(evt.payload, consumePorts);
        return;
      }
      if (evt.method === EVT.taskIntervention || evt.method === EVT.taskSubmitted) {
        // 发起方镜像消费（P2 S5）：hub 定向→本机发起方（lf 组；peer 组不转发
        // intervention，submitted 走账本对账）→ 镜像 human_requests 行 + run 懒建
        // + 跟踪会话里程碑（幂等键 UNIQUE(origin_node_id, remote_id)）。断连窗口
        // （沿 S3/S4 口径）：onEvent 只在 online 后触发——错过的事件无补偿，
        // 重连后由 S7 对账兜底。
        // S9（A4）：镜像行经组清单解析工作站段（失败降级 null——桥内自吞）
        const mirrorPorts = { workstationOf: mirrorWorkstationOf };
        if (evt.method === EVT.taskIntervention) void handleTaskInterventionMirror(evt.payload, mirrorPorts);
        else void handleTaskSubmittedMirror(evt.payload, mirrorPorts);
        return;
      }
      // ── leader 侧委派事件桥（M2e T12）：hub 定向→本机 leader 的账本迁移与进度拍，
      // 挑字段转发 renderer（与 presence 桥同款纪律——异形载荷丢弃）。
      // task.cancelled 无 leader 推送（hub 只定向→目标节点停跑；leader 的取消态
      // 由 task.cancel RPC 回执 + 下一次 task.list 拉取对账），不造无生产者的通道。
      if (evt.method === EVT.taskProgress) {
        // kind（M2.1 T11b 协议 v0.1.4）：'waiting-input' = worker 等用户确认——
        // 枚举校验（异形剥除，permissionTier 先例），leader 摘要 kv 与
        // renderer 推送两路透传（T12 看板等待卡消费）。
        // 1.10.0 平行模式：枚举扩 'received'/'arranged'（peer 草稿生命周期拍——
        // 发送方行保持 pending、卡片切「已接收/已安排」态，spec §5.1）
        const p = evt.payload as { taskId?: unknown; sessionId?: unknown; lastSeq?: unknown; excerpt?: unknown; kind?: unknown };
        if (typeof p.taskId === 'string' && typeof p.sessionId === 'string' && typeof p.lastSeq === 'number' && typeof p.excerpt === 'string') {
          const kind =
            p.kind === 'waiting-input' || p.kind === 'received' || p.kind === 'arranged'
              ? p.kind
              : undefined;
          // T9 外派投影：进度拍先回写本地行（摘要 + running 映射），再桥 renderer
          ensureDelegationSync().handleProgress({ taskId: p.taskId, lastSeq: p.lastSeq, excerpt: p.excerpt, kind });
          broadcast('hub:taskProgress', {
            taskId: p.taskId, sessionId: p.sessionId, lastSeq: p.lastSeq, excerpt: p.excerpt,
            ...(kind !== undefined ? { kind } : {}),
          });
        }
        return;
      }
      if (evt.method === EVT.taskAnswered) {
        // 代答落账通知（M3.1）：定向→本机 leader——kv 留痕（卡片「已远程批准/
        // 拒绝」行数据源）+ 桥 renderer。载荷挑字段（协议 TaskAnsweredEvent 形状，
        // 异形丢弃——presence 桥同款纪律）；by/disposition 属 hub 审计面，卡片
        // 展示只消费 decision。
        const p = evt.payload as { taskId?: unknown; decision?: unknown };
        if (p.taskId !== undefined && typeof p.taskId === 'string' && (p.decision === 'approve' || p.decision === 'deny')) {
          ensureDelegationSync().handleAnswered({ taskId: p.taskId, decision: p.decision });
          broadcast('hub:taskAnswered', { taskId: p.taskId, decision: p.decision });
        }
        return;
      }
      if (evt.method === EVT.taskCompleted || evt.method === EVT.taskFailed || evt.method === EVT.taskInterrupted) {
        const p = evt.payload as { taskId?: unknown; reason?: unknown };
        if (typeof p.taskId !== 'string') return;
        const channel =
          evt.method === EVT.taskCompleted ? 'hub:taskCompleted' : evt.method === EVT.taskFailed ? 'hub:taskFailed' : 'hub:taskInterrupted';
        // reason 语义只在 failed（协议注释：done 不携带）——completed/interrupted 不透传
        // T9 外派投影：终态先回写本地行（六态映射），再桥 renderer
        ensureDelegationSync().handleTerminal(
          evt.method === EVT.taskCompleted ? 'done' : evt.method === EVT.taskFailed ? 'failed' : 'interrupted',
          p.taskId,
          typeof p.reason === 'string' ? p.reason : undefined,
        );
        broadcast(channel, {
          taskId: p.taskId,
          ...(channel === 'hub:taskFailed' && typeof p.reason === 'string' ? { reason: p.reason } : {}),
        });
        return;
      }
      if (evt.method === EVT.nodeOnline) {
        const p = evt.payload as { nodeId: string; nodeName: string };
        broadcast('hub:nodePresence', { kind: 'online', ...p });
        // 种子 upsert——快照是存量面、事件是增量面，两者合成权威在线集合
        // （hello 后上线者入集合，否则重播漏行；本机排除，同捕获点过滤）
        if (presenceSeed && p.nodeId !== nodeId) {
          presenceSeed = [...presenceSeed.filter((n) => n.nodeId !== p.nodeId), { nodeId: p.nodeId, nodeName: p.nodeName }];
        }
      } else if (evt.method === EVT.nodeOffline) {
        const p = evt.payload as { nodeId: string };
        broadcast('hub:nodePresence', { kind: 'offline', ...p });
        // 种子 remove——已下线者不得残留（否则重播推幽灵行）
        if (presenceSeed) presenceSeed = presenceSeed.filter((n) => n.nodeId !== p.nodeId);
      } else if (evt.method === EVT.resourcePublished) {
        // 发布成功广播（spec §3.3/§5）——六字段显式挑出（协议 ResourcePublishedEvent 形状，
        // 不透传整个 payload 防信封杂字段渗入 renderer 契约；异形载荷整条丢弃——
        // 目录缓存是持久消费面，垃圾不得入库，广播与合流同闸）。B10（M3.4 §2.3）：
        // 同事件即时合并进主进程目录源（cache/lastGood upsert）——消「新发布最长
        // 5min（TTL 盲窗）不可见」；全量拉取仍为权威路径，事件只做即时性。
        // M5.0（协议 1.8.0）：ownerNodeId 可选携带——目录增量合并保留归属
        // （徽标/按钮收敛判定输入），缺省不带键（旧 hub 事件零变化）。
        const p = evt.payload as {
          slug?: unknown; type?: unknown; name?: unknown; version?: unknown; author?: unknown; at?: unknown;
          ownerNodeId?: unknown;
        } | null;
        if (
          p !== null && typeof p === 'object' &&
          typeof p.slug === 'string' && typeof p.name === 'string' &&
          typeof p.version === 'string' && typeof p.author === 'string' && typeof p.at === 'number' &&
          (p.ownerNodeId === undefined || typeof p.ownerNodeId === 'string') &&
          (p.type === 'agent' || p.type === 'mcp' || p.type === 'skill' || p.type === 'plugin')
        ) {
          broadcast('hub:resourcePublished', {
            slug: p.slug, type: p.type, name: p.name, version: p.version, author: p.author, at: p.at,
            ...(p.ownerNodeId !== undefined ? { ownerNodeId: p.ownerNodeId } : {}),
          });
          applyHubPublishedEventToCatalog({
            slug: p.slug, type: p.type, name: p.name, version: p.version, author: p.author, at: p.at,
            ...(p.ownerNodeId !== undefined ? { ownerNodeId: p.ownerNodeId } : {}),
          });
        }
      } else if (evt.method === EVT.resourceUnpublished) {
        // 撤回广播（M3.4 §2.3 B12，协议 1.5.0）：三字段挑出（ResourceUnpublishedEvent
        // 形状，异形整条丢弃——同上纪律）→ 桥 renderer（hub:resourceUnpublished：
        // renderer store 清角标键 + 刷新目录）+ B10 目录源剔除（撤回即时不可见）。
        const p = evt.payload as { slug?: unknown; by?: unknown; at?: unknown } | null;
        if (
          p !== null && typeof p === 'object' &&
          typeof p.slug === 'string' && typeof p.by === 'string' && typeof p.at === 'number'
        ) {
          broadcast('hub:resourceUnpublished', { slug: p.slug, by: p.by, at: p.at });
          applyHubUnpublishedEventToCatalog({ slug: p.slug, by: p.by, at: p.at });
        }
      } else if (evt.method === EVT.workspaceMirrored) {
        // 镜像完成组内广播（spec §3.2——组内皆可见谁被镜像到什么版本）。
        // RM-M21-7：广播同时累积镜像登记表（同组×同节点×同空间覆盖 snapshot_id）——
        // 载荷挑字段且先验形状（presence 桥同款纪律：登记表是持久化面，异形载荷
        // 不得入库；此前本分支不校验直接透传，接线登记后收紧为异形丢弃）。
        const p = evt.payload as {
          groupId?: unknown; targetNodeId?: unknown; workspaceName?: unknown;
          snapshotId?: unknown; appliedResources?: unknown; unresolvedRefs?: unknown;
        } | null;
        if (
          p !== null && typeof p === 'object' &&
          typeof p.groupId === 'string' && typeof p.targetNodeId === 'string' &&
          typeof p.workspaceName === 'string' && typeof p.snapshotId === 'string'
        ) {
          mirrorRegistry().record({
            groupId: p.groupId,
            targetNodeId: p.targetNodeId,
            workspaceName: p.workspaceName,
            snapshotId: p.snapshotId,
          });
          broadcast('hub:workspaceMirrored', {
            groupId: p.groupId,
            targetNodeId: p.targetNodeId,
            workspaceName: p.workspaceName,
            snapshotId: p.snapshotId,
            appliedResources: Array.isArray(p.appliedResources) ? p.appliedResources : [],
            ...(Array.isArray(p.unresolvedRefs) ? { unresolvedRefs: p.unresolvedRefs } : {}),
          });
        }
      }
      // 工作组事件桥（M2b）：group.changed → hub:groupChanged（载荷挑字段，见桥内注释）
      bridgeGroupChanged(evt, broadcast);
      // view.appended（M2e T14 leader 侧）：hub 定向推的尾部增量 → 查看面板实时追加。
      // 载荷挑字段（协议 ViewAppendedEvent 形状，异形载荷丢弃——presence 桥同款纪律）。
      // M4.2（1.6.0）：可选 groupId 透传——显式组订阅的锚定记录随推送带出（旧 hub
      // 不发此键 → 载荷零变化；renderer 面板单开不按它分叉，类型面透传消费）
      if (evt.method === EVT.viewAppended) {
        const p = evt.payload as { sessionId?: unknown; events?: unknown; groupId?: unknown };
        if (typeof p.sessionId === 'string' && Array.isArray(p.events)) {
          broadcast('hub:viewAppended', {
            sessionId: p.sessionId,
            events: p.events,
            ...(typeof p.groupId === 'string' ? { groupId: p.groupId } : {}),
          });
        }
      }
    },
    // OBS-1：hello 应答里的在线节点快照 → 逐节点播 presence 种子（在线列表初始面）。
    // 本机节点排除——renderer 用状态快照自合成「本机」行，重复播会双行。
    onHelloSnapshot(nodes) {
      presenceSeed = nodes.filter((n) => n.nodeId !== nodeId);
      broadcastPresenceSeed(presenceSeed);
    },
    // 目标节点侧被动应答（M2c 镜像链）：mirror.apply → 应用器 → mirror.receipt
    onRequest: handleHubRequest,
    // leader 侧两段式第二段：mirror.result res 信封 → hub:mirrorResult 推送
    onUnsolicitedRes(res) {
      bridgeMirrorResult(res, broadcast);
    },
  });
  client.start();
}

/** presence 种子播报（在线列表初始面）——节点集合已排除本机。 */
function broadcastPresenceSeed(nodes: Array<{ nodeId: string; nodeName: string }>): void {
  for (const n of nodes) {
    broadcast('hub:nodePresence', { kind: 'online', nodeId: n.nodeId, nodeName: n.nodeName });
  }
}

/**
 * 在线节点快照重播——renderer 拉状态时补发。
 * 消费面已在位（store 先订阅后拉快照），故拉状态即是把存量快照递给晚挂载的面板。
 */
export function replayPresenceSeed(): void {
  if (!presenceSeed) return;
  broadcastPresenceSeed(presenceSeed);
}

/** hubUrl（http/https origin）→ ws/wss URL + /ws 路径。 */
function wsUrlOf(hubUrl: string): string {
  const u = new URL(hubUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  return u.toString();
}

function normUrl(hubUrl: string): string { return hubUrl.trim().replace(/\/$/, ''); }

/** app ready 后调用：已配置且有凭证则自动连接。 */
export async function initHub(): Promise<void> {
  // worker 干预/提交桥装配（P2 S2）——先于任何可能触发 lifecycle 事件的执行；
  // 幂等 flag 防重复注册。装配只在主进程跑（initHub 调用点唯一：main/index app
  // ready），runtime 子进程虽静态可达本模块，不执行本函数——子进程侧 emit 由
  // forwardLifecycleEvents 第三通道 process.send 转发回主进程本桥。
  ensureRemoteInterveneBridge();

  // S6 跟踪会话回填（P1 矩阵遗留项，spec 2026-11-13 §8.5）：既有 active 外派行
  // 无执行会话 → 补建。纯本地对账（hub RPC 仅用于节点名解析，失败降级
  // 「远端节点」）；fire-and-forget——失败不阻塞连接启动，下次 boot 重试。
  void backfillTrackingSessions({
    listGroups: async () => {
      try {
        return (await originGroupsClient.list()).groups;
      } catch {
        return [];
      }
    },
  })
    .then((count) => {
      if (count > 0) logger.info('外派跟踪会话回填完成', { count });
    })
    .catch((err: unknown) => {
      logger.warn('外派跟踪会话回填失败（不阻塞启动）', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  const cfg = configStore().read();
  if (!cfg) return;
  const token = await getDeviceToken();
  if (!token) { logger.warn('hub 已配置但 keychain 无 device token（跳过连接）'); return; }
  startClient(cfg.hubUrl, cfg.nodeName, token, cfg.nodeId);
}

// ── worker 干预/提交桥装配（P2 S2，spec 2026-11-13 §8.6）─────────────────────
//
// lifecycle-runs 的 RemoteInterveneEvent sink + write-blocked-emit 的 tool_gate
// 行 sink 双注册进 hub/remote-intervene-bridge（delegation 判定 + task.intervene /
// task.report submitted 外发 + 旧版本降级）。注入器方向与 setToolGateHandler
// 先例一致：桥模块（hub 域）反向注册进 task/sandbox 域的 sink 容器，两域模块
// 本体零 import。幂等 flag：initHub 每次调用只装配一次。

let remoteInterveneBridgeArmed = false;

function ensureRemoteInterveneBridge(): void {
  if (remoteInterveneBridgeArmed) return;
  remoteInterveneBridgeArmed = true;
  const handler = createRemoteInterveneHandler({
    clientGetter: () => client,
    selfNodeId: () => configStore().read()?.nodeId ?? null,
    getTask: (id) => getTask(id),
    getActiveRun: (id) => getActiveRun(id),
    // requestHumanFromAgent 的 activeTask 解析同口径：执行会话最新非终态任务
    findActiveTaskByExecutionSession: (sessionId) => {
      const rows = listTasks({ executionSessionId: sessionId })
        .filter((t) => !isTerminal(t.status))
        .sort((a, b) => b.createdAt - a.createdAt);
      return rows[0] ?? null;
    },
    acceptTask: (id) => acceptTask(id),
  });
  setRemoteInterveneSink(handler);
  // tool_gate 行（主进程双写链落行）→ 同形 request_created 事件直发桥
  setToolGateRowSink((row) => {
    try {
      handler({ kind: 'request_created', request: row });
    } catch {
      // handler 自身 total；此处防御性兜底（sink 在授权卡推送主路径上同步调用）
    }
  });
}

export async function hubConfigure(input: { hubUrl: string; nodeName: string }): Promise<HubStatus> {
  const store = configStore();
  const prev: HubConfigRow | null = store.read();
  const hubUrl = normUrl(input.hubUrl);
  const nodeName = input.nodeName.trim();
  if (prev && prev.hubUrl !== hubUrl) {
    // 换址 = 换 hub：旧 device token 是旧 hub 签发的，对新 hub 无效——拿它连新 hub
    // 会连出「鉴权失败 + 退避重连」的死循环。故断开旧连接、清凭证、nodeId 归零，
    // 不起新连接（用户必须重新 enroll 才能接入新 hub）。
    // 换址重置陈旧错误——先清 lastError/lastErrorCode 再停连接（同 hubForget）：
    // client.stop() 会广播 disconnected，lastError 未清则 renderer 收到带历史错误的事件。
    lastError = null;
    lastErrorCode = null;
    client?.stop();
    client = null;
    // 换 hub → 旧 hub 的在线快照作废（重播不得推上个 hub 的节点）
    presenceSeed = null;
    await clearDeviceToken();
    // 下载授权随址收回（F2）：撤旧 hub origin、登新址（下次目录拉取亦会重登，
    // 此处即时生效——避免换址后旧 hub 的 http 下载授权残留）
    unregisterTrustedDownloadOrigin(prev.hubUrl);
    registerTrustedDownloadOrigin(hubUrl);
    store.write({ hubUrl, nodeName, nodeId: null });
    return hubGetStatus();
  }
  // 同址（仅节点名变化）→ 保留 nodeId 与凭证，照旧连接
  store.write({ hubUrl, nodeName, nodeId: prev?.nodeId ?? null });
  await initHub();
  return hubGetStatus();
}

export async function hubEnroll(input: { hubUrl: string; enrollmentToken: string; nodeName: string }): Promise<HubStatus> {
  const hubUrl = normUrl(input.hubUrl);
  const nodeName = input.nodeName.trim();
  const r = await enrollOverHttp(hubUrl, input.enrollmentToken, nodeName);
  await setDeviceToken(r.deviceToken);
  configStore().write({ hubUrl, nodeName, nodeId: r.nodeId });
  startClient(hubUrl, nodeName, r.deviceToken, r.nodeId);
  return hubGetStatus();
}

export async function hubForget(): Promise<void> {
  // 先清 lastError/lastErrorCode 再停连接——client.stop() 内部会 setState('disconnected')
  // 触发一次状态广播，若此时 lastError 还是旧值，renderer 会先收到一条带历史错误的
  // disconnected 事件。
  const prev = configStore().read();
  lastError = null;
  lastErrorCode = null;
  client?.stop();
  client = null;
  presenceSeed = null;
  configStore().clear();
  await clearDeviceToken();
  // 下载授权随接入收回（F2）：旧 hub origin 立即撤出 installer 信任集
  if (prev) unregisterTrustedDownloadOrigin(prev.hubUrl);
  broadcast('hub:stateChanged', {
    state: 'disconnected',
    lastError: null,
    lastErrorCode: null,
    hubProtoVer: null,
  });
}

/** before-quit 调用。 */
export function stopHub(): void {
  client?.stop();
  client = null;
  delegationRunner?.destroy();
  delegationRunner = null;
  viewServer?.destroy();
  viewServer = null;
}
