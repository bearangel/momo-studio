// electron/src/main/task/ipc.handlers.ts
//
// task: 命名空间 IPC handler（B 子系统 B7）。
//
// 暴露通道：
//   - task:create      新建任务（creatorUserId 由 main process 注入常量 'owner'）
//   - task:list        多维过滤 + 排序查询
//   - task:get         按 id 查单条
//   - task:update      部分字段更新（绕过状态机；正常路径请用 task:transition）
//   - task:transition  白名单动作（v2 收窄：paused 暂停 / cancelled 取消；
//                      completed/failed 人话指路 task:submit/accept/reject）
//   - task:cancel      等价 transition(id, 'cancelled')
//   - task:start       启动任务（execution_room 决策树 + 转 in_progress + 锁定 execution_room）
//   - task:submit      提交验收（两段式第一段，v2 Task 16：run submitted + acceptance 请求）
//   - task:accept      验收通过（v2 Task 16：run accepted + 任务 completed）
//   - task:reject      打回（v2 Task 16：run rejected + 任务回 assigned；空白理由人话拒）
//   - task:listRuns    run 历史（v2 Task 16：run_no ASC）
//   - task:getMaxRuns  返工上限读（P3 E1：生效值，脏数据回落缺省 10）
//   - task:setMaxRuns  返工上限写（P3 E1：夹取 1..50 落 kv，返回生效值）
//   - task:move        看板拖拽换列/换组/排序（动作裁决单点在 move.ts，Task 6）
//   - task:archive     归档（仅终态；软删 archived_at）
//   - task:unarchive   取消归档（清 archived_at）
//
// 设计要点：
//   - v2（Task 11）：无登录概念——creatorUserId 由 main process 注入结构常量 'owner'
//     （单用户本地应用；原从 Matrix 登录会话读取，不信任 renderer 传身份的原则不变）。
//   - task:list 直接转发 listTasks 的 opts 结构（workspaceId / status / assigneeAgentId 等）。
//   - P4 Task 2：四个写通道（create/transition/cancel/start）成功后 fire-and-forget
//     广播任务快照（P2P 未启用时内部静默 no-op）。import 叶子模块 task-broadcast
//     ——避免把 electron/传输层依赖拖进 scheduler 等纯逻辑模块的测试图。
//   - Task 5：同一批写通道成功后 notifyExecutor()——队列状态变化立即触发放行评估
//     （executor 内部 100ms 去抖合并；通知丢了有 30s 兜底扫描自愈）。
//   - 看板重构 Task 4：start / resume-paused / cancel 三动作的语义单点抽取到
//     lifecycle.ts（机械搬运，行为零变化），handler 改一行委托——Task 5 的
//     move.ts 与 IPC 同源消费，杜绝两套语义漂移。
import { ipcMain } from 'electron';
import { logger } from '../logger';
import {
  listTasks,
  listRecurrenceArchiveGroups,
  getTask,
  updateTask,
  setTaskPinned,
  type TaskRow,
  type TaskStatus,
  type TaskOrigin,
} from '../storage/tasks/repo';
import { isTerminal } from '../storage/tasks/state-machine';
import { isLocalExecution } from './is-local-execution';
import { agentRunners } from '../agent/runtime-registry';
import { getLane } from '../agent/session-lane';
import { createHubConfigStore } from '../hub/config-store';
import { getDb } from '../storage/db';
import { getGroup } from '../storage/task-groups/repo';
import { notifyExecutor } from './executor';
import { hasDelegationTarget, type StartTaskOpts } from './starter';
import { resolveCreateStatus } from './create-status';
import { inferAutoAccept } from './acceptance-policy';
import { resolveConflict, type ConflictStrategy } from './conflict-resolver';
import { executeConflictResolution } from './conflict-executor';
import { startTaskAndKickoff, resumePausedTask, cancelTask, abortTaskExecution } from './lifecycle';
import {
  pauseForTask,
  promoteDraftToPending,
  submitRun,
  acceptTask,
  rejectTask,
  acceptAndContinue,
  getTaskMaxRuns,
  setTaskMaxRuns,
  type DeliverableInput,
} from './lifecycle-runs';
import { listRuns } from '../storage/tasks/runs-repo';
import { listByTask } from '../storage/tasks/human-requests-repo';
/**
 * D4 只读守卫（spec §3.5）：origin='dispatch' 簿记行由会话链管理，看板写通道
 * 一律拒绝（registry 是真相源；从看板取消子任务留后续交互）。
 * 豁免（2026-11-12 看板治理）：归档域（task:archive / task:unarchive）不在本
 * 守卫范围——终态簿记行允许手动归档清理（archive handler 自有 isTerminal
 * 兜底）；followup 复用已归档行的复活纪律在 dispatch-task-ledger 侧。
 */
function assertNotDispatchRow(id: string): void {
  const t = getTask(id);
  if (t?.origin === 'dispatch') {
    throw new Error('编排子任务由会话链管理，看板只读（不可编辑/移动/顶置）');
  }
}

import { detectInterrupted, resumeTask, type InterruptedTaskInfo } from './resume';
import { executeMove, type MoveTarget } from './move';
import { validateTaskRoutingInput, type TaskRouting } from '../hub/task-routing';
// P3 S3：发起方 steer 成功里程碑（发起方本地写，remote-intervene-bridge 单点——
// delegation_milestone 写入面同模块单源；其 import 图不含本文件，无环）
import { writeOriginSteerMilestone } from '../hub/remote-intervene-bridge';
import { insertTaskWithRelations, setTaskRelations, type TaskRelationsInput } from './relations';

/** renderer task:create 入参（不含 creatorUserId，由 main 注入） */
export interface CreateInput {
  workspaceId: string;
  title: string;
  description?: string;
  priority?: number;
  sourceSessionId?: string | null;
  sourceMessageId?: string | null;
  assigneeAgentId?: string | null;
  /** v29：委派目标三列（互斥） */
  targetTeamId?: string | null;
  /** v29：委派目标三列（互斥） */
  targetSessionId?: string | null;
  /** v29：循环规则 */
  recurrenceRule?: string | null;
  scheduledAt?: number | null;
  deadlineAt?: number | null;
  /** 验收策略（2026-11-19 D8）：缺省按推断单源（循环→自动验收） */
  autoAccept?: boolean;
  /** 看板分组（UX 修复）：落组 id，落库前三重校验（存在/同 ws/未归档） */
  groupId?: string;
  /** M2.1 T6：执行路由三选；异形人话拒绝（不静默降级本机），undefined 落列 NULL=local */
  routing?: TaskRouting;
  /** M3.3：父任务 id（落库前校验存在 + 链无环，relations.ts 单点） */
  parentTaskId?: string | null;
  /** M3.3：直接依赖任务 id 列表（落库前逐个校验存在 + 环检测，同事务插边） */
  dependsOn?: string[];
}

/**
 * M3.3 task:createBatch 返回：per-item union（dispatch-submit 失败聚合先例）——
 * 部分成功允许，与现 renderer 逐行循环 catch 语义等价；失败项携带原始 index。
 */
export interface TaskCreateBatchResult {
  results: Array<{ ok: true; task: TaskRow } | { ok: false; index: number; error: string }>;
}

/** M3.3 批量创建上限（spec §2.1：超限整体 bad_request，不走 per-item 失败） */
export const TASK_CREATE_BATCH_LIMIT = 50;

/** renderer task:list 入参，与 listTasks opts 对齐 */
interface ListOpts {
  workspaceId?: string;
  status?: TaskStatus | TaskStatus[];
  assigneeAgentId?: string;
  executionSessionId?: string;
  sourceSessionId?: string;
  /** 按 source_message_id 集合过滤（会话任务联动 G3：撤回时命中受影响任务）；空数组跳过条件 */
  sourceMessageIds?: string[];
  /** 归档三态透传（看板重构 Task 6）：'exclude' 默认 / 'only' 只回归档 / 'all' 全回 */
  archived?: 'exclude' | 'only' | 'all';
  /** 按来源集合过滤（2026-11-12 看板治理：来源多选下拉）；空数组跳过条件 */
  origin?: TaskOrigin[];
  orderBy?: 'priority' | 'scheduled_at' | 'created_at' | 'created_at_desc';
  limit?: number;
}

/**
 * K7-4 精确中止联动已随 cancel/start 语义一并抽取到 lifecycle.ts
 * （abortTaskExecution）——transition 的 paused/cancelled 分支同源消费。
 */

/** 分组三重校验（存在 / 同 ws / 未归档）——task.create 与 hub:submitRoutedTask 外派落库同源 */
export function assertBoardGroupValid(workspaceId: string, groupId: string): void {
  const group = getGroup(groupId);
  if (!group) {
    throw new Error(`任务分组 ${groupId} 不存在`);
  }
  if (group.workspaceId !== workspaceId) {
    throw new Error(`任务分组 ${groupId} 不属于当前工作空间，拒绝跨工作空间落组`);
  }
  if (group.archivedAt != null) {
    throw new Error(`任务分组 ${groupId} 已归档，不可作为新建任务的目标分组`);
  }
}

/**
 * 表单路径创建单源（M2.1 T8 抽取）：task:create IPC 与 hub:submitRoutedTask 的
 * local 分支共用——draft 语义 / 分组校验 / routing 校验零漂移。
 * K1（2026-09-30 泳道语义重构 §4.1）：表单路径一律 draft——「创建即入队」退役，
 * 启动是唯一入队动作（拖拽/详情按钮，均走 executeMove 单点）；
 * 决策单源 create-status.ts（agent 工具路径见 task-tools.createTask）
 */
export function createTaskFromForm(input: CreateInput): TaskRow {
  const status = resolveCreateStatus(
    { hasDelegationTarget: hasDelegationTarget(input), scheduledAt: input.scheduledAt ?? null },
    'form',
  );
  if (input.groupId != null) {
    assertBoardGroupValid(input.workspaceId, input.groupId);
  }
  // M2.1 T6：routing 三选校验（异形人话抛错——IPC 边界契约违反要响亮）；
  // undefined = 未指定 → 落列 NULL → 读侧 parseTaskRouting 兜底 local
  const routing = validateTaskRoutingInput(input.routing);
  // M3.3：parentTaskId / dependsOn 走 relations 写路径单点（存在性 + 环检测 +
  // 插行插边同事务）；无关系时等价原 insertTask（行为零变化）
  const created = insertTaskWithRelations(
    {
      workspaceId: input.workspaceId,
      title: input.title,
      creatorUserId: 'owner',
      status,
      // D8 验收策略：显式值优先，缺省按推断单源（循环 → 自动验收）
      autoAccept: input.autoAccept ?? inferAutoAccept(input.recurrenceRule),
      description: input.description,
      priority: input.priority,
      sourceSessionId: input.sourceSessionId,
      sourceMessageId: input.sourceMessageId,
      assigneeAgentId: input.assigneeAgentId,
      targetTeamId: input.targetTeamId,
      targetSessionId: input.targetSessionId,
      recurrenceRule: input.recurrenceRule,
      scheduledAt: input.scheduledAt,
      deadlineAt: input.deadlineAt,
      groupId: input.groupId,
      ...(routing !== undefined ? { routing } : {}),
    },
    { parentTaskId: input.parentTaskId, dependsOn: input.dependsOn },
  );
  notifyExecutor();
  return created;
}

// ── 跨节点验收路由（P2 S6，spec 2026-11-13 §8.6 发起方侧）───────────────────
//
// delegation_role='out' 且提交来自远端（pending acceptance 镜像行 origin_node_id
// 非空）的验收/打回：本地 completeAcceptance / rejectTask 先行（本地是账本，
// 状态权威），之后再调 hub task.accept / task.reject 通知执行节点（hub 是对
// worker 的通知通道——worker 侧 S4 消费 accepted/rejected 落本地终态与返工）。
// 远端通知失败不回滚本地（取舍：本地账本已收口；worker 断联窗口由 S7 重连
// 对账兜底），人话 remoteWarning 随行返回供 renderer toast。转发器由 hub 域
// 注入（ipc/index.ts 接线 hubRequest——两域模块零 import，防循环）。

/** 远端验收/打回通知入参（hub task.accept / task.reject 载荷投影） */
export interface RemoteTerminalForwardInput {
  delegationId: string;
  outcome: 'accepted' | 'rejected';
  /** 打回必带（协议契约：reason 进 worker agent 上下文） */
  reason?: string;
}

let remoteTerminalForwarder: ((input: RemoteTerminalForwardInput) => Promise<void>) | null = null;

/** hub 域注入点（ipc/index.ts 装配；null 注销） */
export function setRemoteTerminalForwarder(
  fn: ((input: RemoteTerminalForwardInput) => Promise<void>) | null,
): void {
  remoteTerminalForwarder = fn;
}

// ── 发起方补充指令（P3 S3，spec 2026-11-13 §8.2 steer 槽位）───────────────────
//
// delegation_role='out' 且 delegation_id 在场 → hub task.steer（协议 1.12，
// RPC 有应答；hub 校验发起方身份与账本非终态后定向 worker task.steered——
// worker 侧 S1 消费）。错误人话透传：node_offline 映射 CONTRACT #18 固定文案，
// 其余 hub 原文直出（renderer client 层剥 IPC 包装）。发送成功即时落跟踪会话
// kind='steered' 里程碑（发起方本地写——hub 对 steer 无回执事件给发起方，
// writeOriginSteerMilestone 单点）。转发器注入与 accept/reject 同款纪律。

/** 远端补充指令转发入参（hub task.steer 载荷投影：TaskSteerReq） */
export interface RemoteSteerForwardInput {
  delegationId: string;
  message: string;
}

let steerForwarder: ((input: RemoteSteerForwardInput) => Promise<void>) | null = null;

/** hub 域注入点（ipc/index.ts 装配；null 注销） */
export function setSteerForwarder(
  fn: ((input: RemoteSteerForwardInput) => Promise<void>) | null,
): void {
  steerForwarder = fn;
}

/** 继续通道转发载荷（= hub TaskContinueReq：taskId 为委派 id） */
export interface ContinueForwardInput {
  delegationId: string;
  requirement: string;
}

let continueForwarder: ((input: ContinueForwardInput) => Promise<void>) | null = null;

/** 继续转发装配点（hub 域 ipc/index.ts 接线） */
export function setContinueForwarder(fn: ((input: ContinueForwardInput) => Promise<void>) | null): void {
  continueForwarder = fn;
}

/** hub 错误码 → 人话（peer_version_unsupported 是 1.14 版本门的唯一新增码） */
function humanizeContinueError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('peer_version_unsupported')) {
    return '执行节点版本不支持继续，可改用完成或驳回';
  }
  if (message.includes('需要协议 1.14')) {
    return '当前客户端协议版本过低（需 1.14），请升级后重试';
  }
  if (message.includes('node_offline')) return '执行节点离线，稍后再试';
  return message;
}

/**
 * 验收「继续」路由单点（spec 2026-11-18 DEC-16）：本地任务直接续作；
 * 委派任务「远端先行、本地后落」——远端失败本地零写入，卡片保持待裁决。
 */
export async function continueTaskRouted(
  id: string,
  requirement: string,
): Promise<TaskRow & { remoteWarning?: string }> {
  const before = getTask(id);
  if (!before) throw new Error(`task ${id} 不存在`);
  if (before.delegationRole !== 'out') {
    acceptAndContinue(id, requirement);
    notifyExecutor();
    return { ...getTask(id)! };
  }
  if (before.delegationId === null) throw new Error('任务未委派，无可送达的执行节点');
  const forward = continueForwarder;
  if (forward === null) throw new Error('继续通道未就绪（hub 未配置）');
  try {
    await forward({ delegationId: before.delegationId, requirement: requirement.trim() });
  } catch (err) {
    throw new Error(humanizeContinueError(err));
  }
  acceptAndContinue(id, requirement);
  notifyExecutor();
  return { ...getTask(id)! };
}

/** 补充指令字数上限（协议 TaskSteerReq：message trim 后 1..4000 字，按码点计） */
const STEER_MESSAGE_MAX = 4000;

/** node_offline → CONTRACT #18 固定文案（ui-Toast 底部居中呈现） */
const STEER_NODE_OFFLINE_TEXT = '执行节点离线，稍后再试';

/**
 * 发起方补充指令（S3 路由单点，导出供测试直调）：校验（存在 / delegation_role=
 * 'out' / delegation_id 在场 / message trim 后 1..4000 码点）→ hub task.steer →
 * 成功落跟踪会话里程碑。错误不落里程碑（发送失败指令未送达）。
 */
export async function steerTaskRouted(taskId: string, rawMessage: string): Promise<{ ok: true }> {
  const message = typeof rawMessage === 'string' ? rawMessage.trim() : '';
  if (message === '') {
    throw new Error(`补充指令不能为空（1-${STEER_MESSAGE_MAX} 字）`);
  }
  if (Array.from(message).length > STEER_MESSAGE_MAX) {
    throw new Error(`补充指令最多 ${STEER_MESSAGE_MAX} 字`);
  }
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} 不存在`);
  // 本机执行分支（2026-11-19 任务会话形态分流）：执行节点==本节点（mode local /
  // group·node 调度落本机）→ 直接注入本机执行回合（AgentRunner.steer → 子进程
  // pendingSteers drain 统一落库），不经 hub、不要求 delegationRole out。
  if (isLocalExecution(task, createHubConfigStore(getDb()).read()?.nodeId ?? null)) {
    if (task.status === 'submitted') {
      // DEC-11 同语义：待裁决期 steer 会开出与验收单不一致的僵尸回合
      throw new Error('任务待验收，请先裁决（继续 / 完成 / 驳回）后再补充指令');
    }
    const lane =
      task.executionSessionId !== null && task.executionSessionId !== ''
        ? getLane(task.executionSessionId)
        : null;
    const runner = lane !== null ? agentRunners.get(lane.assignmentId) : undefined;
    const steered =
      lane !== null && runner !== undefined && runner.steer(lane.streamSessionId, message) === true;
    if (!steered) {
      throw new Error('任务当前无执行回合（排队中或已结束），无法补充指令');
    }
    logger.info('本机补充指令已注入执行回合', { taskId });
    return { ok: true };
  }
  if (task.delegationRole !== 'out') {
    throw new Error('仅发起方可对委派任务补充指令');
  }
  if (task.delegationId === null) {
    throw new Error('任务未委派，无可送达的执行节点');
  }
  if (task.status === 'submitted') {
    // spec 2026-11-18 DEC-11：待裁决期 steer 会在执行方开出与验收单不一致的僵尸回合
    throw new Error('任务待验收，请先裁决（继续 / 完成 / 驳回）后再补充指令');
  }
  const forward = steerForwarder;
  if (forward === null) {
    logger.warn('补充指令转发未装配（hub 域未接线）', { taskId });
    throw new Error('补充指令通道未就绪（hub 未配置）');
  }
  try {
    await forward({ delegationId: task.delegationId, message });
  } catch (err) {
    // code 随 RpcRemoteError 保留（client.ts 同款判别）；IPC 只传 message 串——
    // node_offline 必须在主进程映射（renderer 拿不到 code）
    const code = err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code) : undefined;
    if (code === 'node_offline') throw new Error(STEER_NODE_OFFLINE_TEXT);
    throw err;
  }
  logger.info('补充指令已送达 hub（task.steer）', { taskId, delegationId: task.delegationId });
  writeOriginSteerMilestone(task, message);
  return { ok: true };
}

/** 远端提交判定：out 行 + 当前 pending acceptance 为镜像行（提交来自远端） */
function isRemoteSubmitted(task: TaskRow): boolean {
  if (task.delegationRole !== 'out' || task.delegationId === null) return false;
  const pendingAcceptance = listByTask(task.id)
    .filter((r) => r.kind === 'acceptance' && r.status === 'pending')
    .pop();
  return pendingAcceptance?.originNodeId != null;
}

/** 验收通过（S6 路由单点，导出供测试直调）：先本地后远端 + remoteWarning 透传 */
export async function acceptTaskRouted(id: string): Promise<TaskRow & { remoteWarning?: string }> {
  const before = getTask(id);
  if (before !== null && before.delegationRole === 'in') {
    throw new Error('验收裁决权归发起方（本机为执行方）');
  }
  const remote = before !== null && isRemoteSubmitted(before);
  await acceptTask(id);
  notifyExecutor();
  return { ...getTask(id)!, ...(await forwardRemoteTerminal(before, remote, 'accepted')) };
}

/** 打回返工（S6 路由单点，导出供测试直调）：先本地后远端 + remoteWarning 透传 */
export async function rejectTaskRouted(
  id: string,
  reason: string,
): Promise<TaskRow & { remoteWarning?: string }> {
  const before = getTask(id);
  if (before !== null && before.delegationRole === 'in') {
    throw new Error('验收裁决权归发起方（本机为执行方）');
  }
  const remote = before !== null && isRemoteSubmitted(before);
  await rejectTask(id, reason);
  // 打回回 assigned 排队——返工放行（startRun trigger='rework'）由 executor
  // 重评估接手，与 create/update 等写通道同纪律（K3）
  notifyExecutor();
  return {
    ...getTask(id)!,
    ...(await forwardRemoteTerminal(before, remote, 'rejected', reason)),
  };
}

/** 远端通知 + 失败人话（本地不回滚）；非远端提交或未装配 → 无键 */
async function forwardRemoteTerminal(
  before: TaskRow | null,
  remote: boolean,
  outcome: 'accepted' | 'rejected',
  reason?: string,
): Promise<{ remoteWarning?: string } | undefined> {
  if (!remote || before?.delegationId == null) return undefined;
  const forward = remoteTerminalForwarder;
  if (forward === null) {
    logger.warn('远端验收通知未装配（hub 域未接线），本地已收口', {
      taskId: before.id,
      outcome,
    });
    return undefined;
  }
  try {
    await forward({
      delegationId: before.delegationId,
      outcome,
      ...(outcome === 'rejected' && reason !== undefined ? { reason } : {}),
    });
    return undefined;
  } catch (err) {
    // 本地是账本：已 accept/reject 不回滚——worker 侧 S7 重连对账兜底
    const detail = err instanceof Error ? err.message : String(err);
    const action = outcome === 'accepted' ? '验收' : '打回';
    logger.warn(`远端${action}通知失败（本地已收口，S7 对账兜底）`, {
      taskId: before.id,
      delegationId: before.delegationId,
      error: detail,
    });
    return {
      remoteWarning: `远端${action}通知失败：${detail}（本地已${action}，执行节点将在重连后对账）`,
    };
  }
}

export function registerTaskHandlers(): void {
  ipcMain.handle('task:create', async (_evt, input: CreateInput): Promise<TaskRow> =>
    createTaskFromForm(input),
  );

  // M3.3 批量创建（spec §2.1）：上限 50 超限整体 bad_request；逐项走
  // createTaskFromForm（含分组/routing/依赖校验）——per-item union 部分成功允许，
  // 与 renderer 既有逐行循环 catch 语义等价（失败项带原始 index 供 per-line 展示）
  ipcMain.handle(
    'task:createBatch',
    async (_evt, input: { items: CreateInput[] }): Promise<TaskCreateBatchResult> => {
      if (!Array.isArray(input?.items)) throw new Error('task:createBatch 需要 items 数组');
      if (input.items.length === 0) throw new Error('task:createBatch items 不能为空');
      if (input.items.length > TASK_CREATE_BATCH_LIMIT) {
        throw new Error(
          `批量创建一次最多 ${TASK_CREATE_BATCH_LIMIT} 条（收到 ${input.items.length} 条）`,
        );
      }
      const results = input.items.map(
        (
          item,
          index,
        ): { ok: true; task: TaskRow } | { ok: false; index: number; error: string } => {
          try {
            return { ok: true, task: createTaskFromForm(item) };
          } catch (err) {
            return { ok: false, index, error: err instanceof Error ? err.message : String(err) };
          }
        },
      );
      return { results };
    },
  );

  // M3.3 关系写通道（parentTaskId / dependsOn 各自可选更新；dependsOn 全量替换；
  // 环拒绝人话报错含环路径）。关系变化可能解锁 assigned 任务 → 触发放行重评估
  ipcMain.handle(
    'task:setRelations',
    async (_evt, input: { taskId: string } & TaskRelationsInput): Promise<TaskRow> => {
      assertNotDispatchRow(input.taskId);
      const row = setTaskRelations(input);
      notifyExecutor();
      return row;
    },
  );

  ipcMain.handle('task:list', async (_evt, opts: ListOpts): Promise<TaskRow[]> => {
    return listTasks(opts);
  });

  // 归档区循环链聚合（2026-11-19 归档聚合）：次数/最近完成 SQL 直出——
  // 不受平铺 task:list limit 截断影响
  ipcMain.handle(
    'task:listRecurrenceGroups',
    async (_evt, workspaceId: string) => listRecurrenceArchiveGroups(workspaceId),
  );

  ipcMain.handle('task:get', async (_evt, id: string): Promise<TaskRow | null> => {
    return getTask(id);
  });

  ipcMain.handle(
    'task:update',
    async (_evt, id: string, patch: Parameters<typeof updateTask>[1]): Promise<void> => {
      assertNotDispatchRow(id);
      // minor-11 + 看板重构 Task 8 契约洞加固：task:update 是部分字段补丁通道，
      // 但 status / pinnedAt / archivedAt / groupId 四字段各有专属通道，
      // 直接写会绕过 move / pin / archive 的不变式（Task 7 review 发现通用 update
      // 可绕过分组位与归档域校验）。状态走 task:transition / task:submit /
      // task:accept / task:reject（v2 收窄：transition 仅 paused/cancelled，
      // 完成必经验收链——renderer 误传/恶意传 status 一律忽略），
      // 分组走 task:move，顶置走 task:setPinned，
      // 归档走 task:archive / task:unarchive，分组管理走 taskGroup 通道。
      // M3.3 追加：parentTaskId / dependsOn 走 task:setRelations（存在性 + 环检测
      // 专属校验），blocked / blockedBy 为只读派生态——五字段同样剥离。
      // renderer 误传时记 warn 帮助定位，受保护字段静默丢弃
      let applied: Partial<TaskRow>;
      if (patch) {
        // 边界放宽说明：dependsOn / parentId 非 TaskRow 字段，但 renderer 误传时
        // 也须剥离——按关系字段一并接收处理
        const patchRecord = patch as Partial<TaskRow> & {
          dependsOn?: unknown;
          parentId?: unknown;
        };
        const {
          status: _status,
          pinnedAt: _pinnedAt,
          archivedAt: _archivedAt,
          groupId: _groupId,
          parentTaskId: _parentTaskId,
          blocked: _blocked,
          blockedBy: _blockedBy,
          dependsOn: _dependsOn,
          parentId: _parentId,
          ...rest
        } = patchRecord;
        const protectedKeys = (
          [
            'status',
            'pinnedAt',
            'archivedAt',
            'groupId',
            'parentTaskId',
            'dependsOn',
            'parentId',
            'blocked',
            'blockedBy',
          ] as const
        ).filter((k) => Object.prototype.hasOwnProperty.call(patchRecord, k));
        if (protectedKeys.length > 0) {
          logger.warn(
            `task:update 携带受保护字段已剥离（${protectedKeys.join('/')}）——` +
              '状态走 task:transition / task:submit / task:accept / task:reject，分组请用 task:move，' +
              '顶置请用 task:setPinned，归档请用 task:archive / task:unarchive，' +
              '分组管理请走 taskGroup 通道，任务关系（父任务/依赖）请用 task:setRelations，' +
              'blocked/blockedBy 为只读派生态',
            { id },
          );
        }
        applied = rest;
        // 1.10.0 编辑对齐（spec §6）：执行位置（routing）可在「未派发态」修改——
        // 校验形状（异形人话拒）+ 在账行（delegation_id 非空且非 failed）拒改道
        // （重派换道走既有失败重派语义）。切到外派路由的 draft 行原子提级 pending
        // （与 createRemoteTask 同语义；status 专属通道纪律不变——此为服务端派生）
        if (Object.prototype.hasOwnProperty.call(patchRecord, 'routing')) {
          const t = getTask(id);
          if (patchRecord.routing === undefined) {
            delete (applied as Partial<TaskRow>).routing;
          } else if (t && t.delegationId !== null && t.status !== 'failed') {
            throw new Error('任务已派发在账，不能改执行位置（失败后可重派换道）');
          } else {
            const routing = validateTaskRoutingInput(patchRecord.routing) ?? { mode: 'local' as const };
            (applied as Partial<TaskRow>).routing = routing;
            const wasDraft = t?.status === 'draft';
            updateTask(id, applied);
            if (wasDraft && routing.mode !== 'local') {
              // v2 收敛（消费面 ①-23，Task 15）：draft→pending 提级走服务投影单点
              promoteDraftToPending(id);
            }
            applied = {};
            notifyExecutor();
            return;
          }
        }
      } else {
        applied = patch;
      }
      updateTask(id, applied);
      // K3（P0 修复）：与 create/transition/cancel/start 四写通道对齐——
      // 编辑可能改 assignee/目标（排队任务的执行对象变化），
      // 成功后必须触发调度重评估 + P2P 快照广播
      notifyExecutor();
    },
  );

  ipcMain.handle(
    'task:transition',
    async (_evt, id: string, to: TaskStatus): Promise<TaskRow> => {
      assertNotDispatchRow(id);
      // v2 白名单收窄（§9.3 行9，Task 15）：renderer 只剩暂停/取消两个状态动作——
      //   - completed/failed：完成必经验收链（task:submit 提交 → task:accept /
      //     task:reject 裁决），失败属 agent/运行时语义，renderer 不可直转
      //   - 其余状态各有专属通道：启动 task:start、恢复 task:resume、入队/
      //     验收 task:move / task:submit
      if (to === 'paused') {
        pauseForTask(id);
        abortTaskExecution(id);
        notifyExecutor();
        return getTask(id)!;
      }
      if (to === 'cancelled') {
        await cancelTask(id);
        return getTask(id)!;
      }
      if (to === 'completed' || to === 'failed') {
        throw new Error(
          `task:transition 不再支持直转 ${to}——完成必经验收链：请用 task:submit 提交交付，` +
            `验收走 task:accept / task:reject`,
        );
      }
      throw new Error(
        `task:transition 仅支持暂停（paused）与取消（cancelled）——启动用 task:start，` +
          `恢复用 task:resume，入队与验收用 task:move / task:submit`,
      );
    },
  );

  ipcMain.handle('task:cancel', async (_evt, id: string): Promise<void> => {
    assertNotDispatchRow(id);
    // 语义单点在 lifecycle.ts（cancelTask），move.ts 同源消费
    await cancelTask(id);
  });

  // ── v2 两段式完成 IPC 面（Task 16，spec §6.5）──
  // submit → submitted + acceptance 请求；accept / reject → 验收裁决。
  // 语义单点全在 lifecycle-runs（task-tools agent 工具路径同源消费），
  // handler 只做 D4 守卫 + 调度重评估 + 行回读。
  ipcMain.handle(
    'task:submit',
    async (_evt, id: string, deliverable: DeliverableInput): Promise<TaskRow> => {
      assertNotDispatchRow(id);
      await submitRun(id, deliverable);
      notifyExecutor();
      return getTask(id)!;
    },
  );

  ipcMain.handle('task:accept', async (_evt, id: string): Promise<TaskRow & { remoteWarning?: string }> => {
    assertNotDispatchRow(id);
    return acceptTaskRouted(id);
  });

  // 空白理由由 rejectTask 人话拒（「打回必须填写理由」——与 move 打回双保险）
  ipcMain.handle(
    'task:reject',
    async (_evt, id: string, reason: string): Promise<TaskRow & { remoteWarning?: string }> => {
      assertNotDispatchRow(id);
      return rejectTaskRouted(id, reason);
    },
  );

  // P3 S3：发起方补充指令（steerTaskRouted 单点：out 校验 + hub task.steer +
  // 错误人话透传 + 成功里程碑；返回 ok 恒真——失败以 throw 表达）
  ipcMain.handle(
    'task:steer',
    async (_evt, input: { taskId: string; message: string }): Promise<{ ok: true }> => {
      if (typeof input?.taskId !== 'string') throw new Error('task:steer 需要 taskId');
      return steerTaskRouted(input.taskId, input.message);
    },
  );

  // 1.14.0 验收继续（spec 2026-11-18 DEC-16）：本地直写；委派远端先行
  ipcMain.handle(
    'task:continue',
    async (_evt, id: string, requirement: string): Promise<TaskRow & { remoteWarning?: string }> => {
      if (typeof id !== 'string') throw new Error('task:continue 需要 taskId');
      if (typeof requirement !== 'string') throw new Error('task:continue 需要 requirement 字符串');
      return continueTaskRouted(id, requirement);
    },
  );

  // run 历史列表（run_no ASC——runs-repo 单点排序）
  ipcMain.handle('task:listRuns', async (_evt, id: string) => {
    return listRuns(id);
  });

  // 返工上限可配（P3 E1）：读=生效值（脏数据回落缺省）；写=归一化夹取 1..50
  // 后落 kv 并返回生效值。语义单点 lifecycle-runs（startRun / rejectTask 同源）
  ipcMain.handle('task:getMaxRuns', () => getTaskMaxRuns());
  ipcMain.handle('task:setMaxRuns', (_evt, input: number) => setTaskMaxRuns(input));

  // 看板重构 Task 6：拖拽换列走单一通道——renderer 只发目标（column/groupId），
  // 动作裁决（start/complete/cancel/换组/no-op）全部在 executeMove 单点；
  // v2 生命周期（Task 8）：opts.reason 随打回（submitted→assigned）透传
  ipcMain.handle(
    'task:move',
    async (_evt, id: string, target: MoveTarget, opts?: { reason?: string }): Promise<TaskRow> => {
      assertNotDispatchRow(id);
      const row = await executeMove(id, target, opts);
      return row;
    },
  );

  // 顶置开关（迁移 050）：全状态可 pin；语义单点在 repo.setTaskPinned
  // （重复 pin 刷新时间戳 = 重新压顶）。排序属本地看板视图域，但快照广播
  // 保持远端镜像 TaskRow 一致
  ipcMain.handle(
    'task:setPinned',
    async (_evt, id: string, pinned: boolean): Promise<TaskRow> => {
      assertNotDispatchRow(id);
      const row = setTaskPinned(id, pinned);
      return row;
    },
  );

  // 归档域（看板重构 Task 6）：仅终态任务可归档（软删，archived_at 置时间戳）；
  // 非终态拒绝——运行中任务先 cancel/complete 再归档。归档改变 task:list 默认
  // 可见性，成功后同样广播快照。
  // 2026-11-12 看板治理：dispatch 簿记行豁免 D4 守卫——终态簿记行可归档清理
  // （isTerminal 检查对 dispatch 行同样兜底：在途链行非终态 → 拒绝路径不变）；
  // followup 复用已归档链时 ledgerInsertDispatch 复位并清 archived_at（复活纪律）
  ipcMain.handle('task:archive', async (_evt, id: string): Promise<TaskRow> => {
    const t = getTask(id);
    if (!t) throw new Error(`task ${id} 不存在`);
    if (!isTerminal(t.status)) throw new Error('仅终态任务可归档(completed/failed/cancelled)');
    updateTask(id, { archivedAt: Date.now() });
    return getTask(id)!;
  });

  // 解档同豁免（对称性：归档进得去也要出得来）；archived_at 清空不触碰状态机
  ipcMain.handle('task:unarchive', async (_evt, id: string): Promise<TaskRow> => {
    updateTask(id, { archivedAt: null });
    return getTask(id)!;
  });

  // K7-5 + v2.6.0 多路恢复：按任务 status 分流（spec §5.6 IPC 面 + D6 卡片唯一闸门）：
  //   - paused → K7-5 既有路径（transition paused→in_progress + kickoff 重注入）
  //   - in_progress → v2.6.0 断点续跑（resumeTask：rebuildTurn + 消息行翻回 streaming
  //     + TaskConfig resume 载荷 + 既有 AgentRunner 派发）
  //   - assigned / session_queued → v2.6.0 全新执行（resumeTask 内部 notifyExecutor
  //     触发既有 executor 放行——并发闸 + 队列序 + kickoff 天然生效）
  // 返回值多路：paused 返回 TaskRow（K7-5 兼容），in_progress/assigned/queued 返回
  // TaskRow & { streamSessionId? }（v2.6 新增；renderer 可选读取用于 SSE 关联）
  ipcMain.handle(
    'task:resume',
    async (_evt, id: string): Promise<TaskRow & { streamSessionId?: string }> => {
      assertNotDispatchRow(id);
      const before = getTask(id);
      if (!before) throw new Error(`task ${id} 不存在`);

      if (before.status === 'paused') {
        // 语义单点在 lifecycle.ts（resumePausedTask = K7-5：transition + kickoff
        // 重注入），move.ts 同源消费
        return await resumePausedTask(id);
      }

      // v2.6.0：其余可恢复状态交由 resume.ts resumeTask 统一处理
      const result = await resumeTask(id);
      const after = getTask(id);
      return { ...(after ?? before), streamSessionId: result.streamSessionId };
    },
  );

  // v2.6.0 启动恢复卡数据源（spec §5.2）：列出 in_progress / assigned / session_queued
  // 任务供 renderer 渲染 ResumeNotice（spec §6：boot 现查现示，空列表不渲染）。
  // D6：检测时不改任务状态（卡片是唯一闸门；scheduler 边界回归锁在 resume.test.ts 固化）。
  ipcMain.handle(
    'task:listInterrupted',
    async (): Promise<InterruptedTaskInfo[]> => {
      return detectInterrupted();
    },
  );

  ipcMain.handle(
    'task:start',
    async (
      _evt,
      id: string,
      opts?: StartTaskOpts,
    ): Promise<{ executionSessionId: string; createdNewRoom: boolean }> => {
      assertNotDispatchRow(id);
      // 语义单点在 lifecycle.ts（startTaskAndKickoff = K9 全语义：startTask +
      // 幂等判定 + kickoff 注入 + 失败转 failed + broadcast/notify），move.ts
      // 同源消费。IPC 返回形状保持两字段（renderer 契约不变）
      const result = await startTaskAndKickoff(id, opts);
      return {
        executionSessionId: result.executionSessionId,
        createdNewRoom: result.createdNewRoom,
      };
    },
  );

  // B9：当用户在 execution_room 内 @agent 启动新任务、但当前会话已有 in_progress
  // 任务时，ConflictDialog（或自动策略）调此通道。触发条件检测在 B11 runtime-entry。
  ipcMain.handle(
    'task:resolveConflict',
    async (
      _evt,
      input: {
        newTaskId: string;
        currentTaskId: string;
        currentRoomId: string;
        strategy: ConflictStrategy;
      },
    ) => {
      const resolution = resolveConflict(input);
      return executeConflictResolution(resolution, {
        newTaskId: input.newTaskId,
        currentTaskId: input.currentTaskId,
        currentRoomId: input.currentRoomId,
      });
    },
  );

  logger.info('Task IPC handlers 已注册');
}
