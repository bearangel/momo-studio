// electron/src/main/agent/dispatch-wait.ts
//
// PM 侧 dispatch 等待机器（Task 13 自 runtime-entry.ts 迁出）。
//
// executeDispatch：构建 dispatch 消息经内部事件桥发出（child IPC → 主进程
// RouterService.routeDispatch → sub-agent executeTask），并注册 pendingReplies
// 等待对应 task_id 的 task_reply；回执经反向链路回来——
//   sub runTaskChatLoop → sendTaskReplyEvent → RouterService.routeTaskReply
//   → AgentRunner.notifyTaskReply → child.send({type:'task-reply'})
//   → runtime-entry taskMessageListener → handleTaskReplyIpc → handleTaskReply
//   → resolve/reject pending promise。
//
// 渐进式超时：3 分钟 → 6 分钟两阶段；收到 in_progress 回执重置当前阶段。
//
// v2.8.0 Orchestration：新增 bg 句柄表（dispatch_bg 派发 / dispatch_gather 收割
// 的内存态，spec 2026-09-12 orchestration-primitives §4）——handleTaskReply
// 单点收口扩展：pendingReplies miss 后查 bgHandles 翻转句柄并唤醒 gather waiter。

import {
  buildDispatchMessage,
  buildAbortDispatchMessage,
  parseTaskReply,
} from './dispatch';
import type { DispatchContent } from './dispatch';
import { sendDispatchEvent, sendAbortDispatchEvent } from './internal-event';
import type { RuntimeConfig } from './runtime-config';
import type { SubAgentRef } from './builtin-tools';
import { getDb } from '../storage/db';
import { randomUUID } from 'node:crypto';
import { rebuildSubConversation } from './sub-history-reconstructor';
import { appendFollowupQuestionRow } from './chain-writer';

/** 渐进式 dispatch 回复超时：第一阶段 3 分钟，第二阶段 6 分钟，合计 9 分钟 */
const DISPATCH_STAGE_TIMEOUTS_MS = [180_000, 360_000];
/** dispatch 总最大等待时间（所有阶段之和） */
const DISPATCH_TOTAL_TIMEOUT_MS = DISPATCH_STAGE_TIMEOUTS_MS.reduce((a, b) => a + b, 0);

// dev 行为日志开关（runtime-entry main() 按 devMode 同步开启）
let traceEnabled = false;

export function setDispatchTraceEnabled(enabled: boolean): void {
  traceEnabled = enabled;
}

function trace(event: string, fields?: Record<string, unknown>): void {
  if (!traceEnabled) return;
  const parts = fields
    ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')
    : '';
  process.stdout.write(`${event}${parts}\n`);
}

// === Dispatch：主 agent 等待子 agent 回执 ===

interface PendingReply {
  /** v1.4：resolve 携带 body + toolCallsUsed，供主 agent 扣减共享预算 */
  resolve: (value: { body: string; toolCallsUsed: number }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  stage: number;
  subSlug: string;
  /**
   * minor-10：移除 abort 监听器的清理函数（保存在 entry 上便于 settle
   * 路径调用）——reply 到达 / 超时 reject / 自身 onAbort 时应移除
   * 外部 abortSignal 的 listener，防止信号到来时调用已经 settle 的
   * pending.onAbort 重复发 abort_dispatch 事件
   */
  abortCleanup?: () => void;
}

/** pending dispatch 回执：task_id → 等待中的 Promise（主 agent 发出 dispatch 后注册） */
const pendingReplies = new Map<string, PendingReply>();

// === v2.8.0 Orchestration：bg 句柄表（异步 dispatch 族，spec §4.1） ===

/** 后台 dispatch 句柄：dispatch_bg 派发后立即返回，句柄留在本表；handleTaskReply 单点翻转 done，dispatch_gather 幂等读取（T4 落地执行体） */
export interface BgHandle {
  slug: string;
  status: 'in_flight' | 'done' | 'cancelled';
  startedAt: number;
  /**
   * 子 agent 流 id（dispatch_bg 派发时存入）。dispatch_cancel 发 abort_dispatch
   * 的定位键——routeAbortDispatch 以它匹配 runner 活跃流，缺字段即整包丢弃。
   */
  subStreamSessionId?: string;
  /** settle 后填充（翻转 done 时写入；cancelled 态保持 undefined——迟到 body 被忽略） */
  body?: string;
  toolCallsUsed?: number;
  completedAt?: number;
}

/** 同 PM 在途 bg 句柄上限（spec §4.2：在途数 ≥ 8 → 工具报错含清单；T4 executeDispatchBg 强制） */
export const BG_HANDLE_LIMIT = 8;

/** bg 句柄表：taskId → 句柄。生产写入口是 T4 executeDispatchBg（注册 in_flight）与 dispatch_cancel（标 cancelled） */
const bgHandles = new Map<string, BgHandle>();

/** gather 等待者：taskId → 等待翻转的回调集合（spec §4.2 实现裁定——独立于 pendingReplies 键空间，taskId 语义已被 bgHandles 占有） */
const gatherWaiters = new Map<string, Set<(h: BgHandle) => void>>();

/** 查询某后台任务的句柄（T4 dispatch_status / dispatch_gather / UI 消费；幂等读不删句柄） */
export function getBgHandle(taskId: string): BgHandle | undefined {
  return bgHandles.get(taskId);
}

/** 列出全部 in_flight 后台句柄（T4 上限报错清单 + UI 消费） */
export function listInFlightBg(): Array<{ taskId: string; slug: string; startedAt: number }> {
  const out: Array<{ taskId: string; slug: string; startedAt: number }> = [];
  for (const [taskId, h] of bgHandles) {
    if (h.status === 'in_flight') out.push({ taskId, slug: h.slug, startedAt: h.startedAt });
  }
  return out;
}

/**
 * 注册 gather 等待者：句柄翻转 done 时被唤醒（收到更新后的句柄）。
 * 返回清理函数——gather 超时路径调用以移除 waiter（spec 状态表：句柄保留、waiter 清理）。
 * T4 dispatch_gather 消费；本模块内仅 handleTaskReply bg 分支唤醒。
 */
export function addGatherWaiter(taskId: string, waiter: (h: BgHandle) => void): () => void {
  let set = gatherWaiters.get(taskId);
  if (!set) {
    set = new Set();
    gatherWaiters.set(taskId, set);
  }
  set.add(waiter);
  return () => {
    const s = gatherWaiters.get(taskId);
    if (!s) return;
    s.delete(waiter);
    if (s.size === 0) gatherWaiters.delete(taskId);
  };
}

/** 翻转后唤醒该 taskId 的全部 gather waiter（一次性排空——waiter 是 resolve 回调，唤醒即消费，重复 reply 不重复唤醒） */
function wakeGatherWaiters(taskId: string, handle: BgHandle): void {
  const waiters = gatherWaiters.get(taskId);
  if (!waiters) return;
  gatherWaiters.delete(taskId);
  for (const w of waiters) w(handle);
}

// 测试缝（照 memory/index.ts __setMemoryProviderForTest 先例）：T4 executeDispatchBg
// 落地前，测试经 seed 直接注入句柄驱动 handleTaskReply 的 bg 分支；生产代码不经此
// 路径写表（正式写入口是 executeDispatchBg / dispatch_cancel）。

/** 测试用：注入一个 bg 句柄（形态由调用方完全控制） */
export function __seedBgHandleForTest(taskId: string, handle: BgHandle): void {
  bgHandles.set(taskId, handle);
}

/** 测试用：清空句柄表 + waiter 表（用例隔离） */
export function __resetBgStateForTest(): void {
  bgHandles.clear();
  gatherWaiters.clear();
}

/**
 * 会话边界判定（spec §4.7 会话语义的执行时修正，2026-09-07 主机报告）：
 * dispatch 快照是实例级（跨该实例所有 leader 会话的并集，spawn 时定型），
 * 但 dispatch 只在「当前会话」内合法——单成员快速会话中即使带着工具也不得委派。
 *
 * 返回「当前会话成员 ∩ config.subAgents」；任一条件不满足（会话不存在 /
 * 有效成员 ≤ 1 / 自己非成员或非 leader）返回 null。
 * 消费方：executeDispatch 执行校验（assertSessionDispatchAllowed）+
 * runChatLoop 工具暴露面过滤（二段修复：不满足时工具与教学 prompt 根本不注入）。
 */
export function getSessionDispatchScope(
  executionSessionId: string | undefined,
  config: RuntimeConfig,
): SubAgentRef[] | null {
  if (!executionSessionId) return null;
  let rows: Array<{ instance_id: string; is_leader: number }>;
  try {
    rows = getDb()
      .prepare('SELECT instance_id, is_leader FROM session_members WHERE session_id = ?')
      .all(executionSessionId) as Array<{ instance_id: string; is_leader: number }>;
  } catch {
    // DB 不可用 / 表缺失（如测试空库）——保守视为无委派能力，不阻塞 chat loop
    return null;
  }
  if (rows.length <= 1) return null;
  const me = rows.find((r) => r.instance_id === config.agentAssignmentId);
  if (!me || me.is_leader !== 1) return null;
  const memberIds = new Set(rows.map((r) => r.instance_id));
  return config.subAgents.filter((s) => memberIds.has(s.assignmentId));
}

/**
 * executeDispatch 入口的会话边界校验（深度防御——暴露面过滤之外的最终防线）。
 */
function assertSessionDispatchAllowed(
  executionSessionId: string | undefined,
  config: RuntimeConfig,
  targetAssignmentId: string,
): void {
  const scoped = getSessionDispatchScope(executionSessionId, config);
  if (!scoped) {
    throw new Error('当前会话不支持委派（单成员会话或你不是该会话 leader）——请直接自行完成任务');
  }
  if (!scoped.some((s) => s.assignmentId === targetAssignmentId)) {
    throw new Error('目标 agent 不是当前会话成员，不能跨会话委派');
  }
}

/** dispatchOnce 选项：同步 executeDispatch / 异步 executeDispatchBg（T4）共用的派发参数 */
interface DispatchOnceOpts {
  toolBudget?: number;
  /** 子 agent 自身流 id（写入 dispatch 消息 sub_stream_session_id，P0-7） */
  subStreamSessionId?: string;
  /** PM 自身流 id（写入 tool_stream_session_id，子行 parentStreamSessionId 来源） */
  pmStreamSessionId?: string;
  /** PM 当前执行的会话——dispatch/abort 内部事件发往它（P0-8） */
  executionSessionId?: string;
  /** dev 行为日志标签（同步路径沿用 '→ dispatch' 零变化；bg 路径 '→ dispatch_bg'） */
  traceLabel?: string;
  /**
   * 消息构建后、发送前的同步回调：注册各自等待态（同步注册 pendingReplies /
   * bg 注册 bgHandles）——维持「先注册后发送」防竞态纪律，子 agent 极快回执
   * 时 reply 不因注册迟到而丢失。
   */
  onBuilt?: (taskId: string, sub: SubAgentRef) => void;
}

/**
 * 派发内部共用（T4 抽出）：定位子 agent → 会话边界校验 → 构建 dispatch 消息 →
 * （onBuilt 注册等待态）→ 经内部事件桥发出。同步 executeDispatch 与异步
 * executeDispatchBg 共用；返回 taskId（buildDispatchMessage 单点生成的链 ID）。
 */
function dispatchOnce(
  subSlug: string,
  task: string,
  config: RuntimeConfig,
  opts: DispatchOnceOpts,
): { taskId: string; sub: SubAgentRef } {
  const sub = config.subAgents.find((s) => s.slug === subSlug);
  if (!sub) throw new Error(`未知子 agent: ${subSlug}`);

  // 会话边界（拒绝时 throw → 工具错误返回 LLM，不发事件不注册等待态）
  assertSessionDispatchAllowed(opts.executionSessionId, config, sub.assignmentId);

  if (opts.traceLabel !== undefined) {
    trace(opts.traceLabel, { target: subSlug, task: `${task.length}字`, budget: opts.toolBudget });
  }

  // v2（Task 10）：from/to 均为 assignmentId——RouterService 直接以此定位 runner
  const dispatch = buildDispatchMessage({
    body: task,
    fromAssignmentId: config.agentAssignmentId,
    toAssignmentId: sub.assignmentId,
    deadlineMs: DISPATCH_TOTAL_TIMEOUT_MS,
    toolBudget: opts.toolBudget,
    toolStreamSessionId: opts.pmStreamSessionId,
    subStreamSessionId: opts.subStreamSessionId,
  });

  opts.onBuilt?.(dispatch.content.task_id, sub);

  // sender 携带 agent 本地身份 agentUserId（Task 10）。展开 DispatchContent 为
  // 匿名对象类型以满足内部事件协议的 Record<string, unknown> 索引签名。
  sendDispatchEvent(opts.executionSessionId ?? '', config.agentUserId, { ...dispatch.content });
  return { taskId: dispatch.content.task_id, sub };
}

/**
 * 注册 pendingReplies 等待 task_reply（executeDispatch / executeFollowup 共用
 * 等待封装，v2.8.0 T6 抽出——两执行体的渐进式超时与 abort 清理语义完全一致）。
 *
 * 防竞态纪律：本函数必须同步调用于 dispatch 事件发送**之前**（Promise executor
 * 同步执行，pendingReplies.set 先于 sendDispatchEvent 返回）——子 agent 极快
 * 回执时 reply 不因注册迟到而丢失。
 *
 * abort 语义（v1.5.1 起）：signal 触发即清理 entry + reject(AbortError)，不等
 * 渐进式超时；settle 路径（reply 到达 / 超时）经 abortCleanup 移除监听器，
 * 防 reply 后再 abort 重复发 abort_dispatch（minor-10）。
 */
function waitForTaskReply(
  taskId: string,
  subSlug: string,
  config: RuntimeConfig,
  executionSessionId: string | undefined,
  subStreamSessionId: string | undefined,
  signal?: AbortSignal,
): Promise<{ body: string; toolCallsUsed: number }> {
  return new Promise<{ body: string; toolCallsUsed: number }>((resolve, reject) => {
    pendingReplies.set(taskId, {
      resolve,
      reject,
      timer: setTimeout(() => {}, 0), // 占位，armDispatchTimer 会替换
      stage: 0,
      subSlug,
    });
    armDispatchTimer(taskId);

    // v1.5.1：监听 abortSignal，被中断时立即清理 + reject（不等渐进式超时）
    if (signal) {
      const onAbort = (): void => {
        const entry = pendingReplies.get(taskId);
        if (entry) {
          clearTimeout(entry.timer);
          pendingReplies.delete(taskId);
        }
        // 发 abort_dispatch 内部事件兜底通知子 agent——子 agent 此刻可能尚未启动，
        // 主进程 abortStream 找不到它。事件桥是 transient 进程内桥（路由表在
        // RouterService.runners Map），未启动的子 agent 收不到此事件；兜底是
        // PM 侧 onAbort 立即 reject + 子 agent 自身渐进式超时（3+6=9 分钟）
        // 自然收敛——而非依赖事件桥把 abort 投递到后续启动的子 agent。
        const abortEvt = buildAbortDispatchMessage({
          taskId,
          subStreamSessionId,
        });
        sendAbortDispatchEvent(executionSessionId ?? '', config.agentUserId, abortEvt.content);
        const err = new Error('dispatch 被中断');
        err.name = 'AbortError';
        reject(err);
      };
      const cleanup = (): void => signal.removeEventListener('abort', onAbort);
      // settle 路径（reply 到达 / 超时 reject）需调 cleanup 移除监听器——否则
      // 后续 abort 会再次触发 onAbort（即便 entry 已删，仍会发 abort_dispatch
      // 给本不存在的子 agent / 污染 send 计数）
      const entry = pendingReplies.get(taskId);
      if (entry) entry.abortCleanup = cleanup;
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * 主 agent 执行 dispatch：<slug> 工具——经内部事件桥发送 dispatch 消息
 * （child IPC → internal-event-bridge → RouterService.routeDispatch），
 * 然后等待对应 task_id 的 task_reply（渐进式超时）。
 *
 * 防竞态：必须先注册 pending 再发送消息。若先发送后注册，子 agent 极快回执时
 * task_reply 会在 pending.set 之前到达，handleTaskReply 找不到 pending 导致回执丢失。
 */
export async function executeDispatch(
  subSlug: string,
  task: string,
  config: RuntimeConfig,
  toolBudget?: number,
  /**
   * 子 agent 自身流 id（PM 在 dispatch tool_call chunk 预生成的 subStreamSessionId）。
   * 写入 dispatch 消息 sub_stream_session_id——routeDispatch 用它作子 task 的
   * streamSessionId，保证子消息行与 renderer chip 的查找键一致（P0-7）。
   */
  subStreamSessionId?: string,
  /** PM 自身流 id——子 agent 消息行 parentStreamSessionId 的来源 */
  pmStreamSessionId?: string,
  /**
   * PM 当前执行的会话（用户发消息的会话）。dispatch/abort 内部事件发往它——
   * 子 agent 的消息行因此落在用户所在会话，dispatch chip 才能反查到子流
   * （P0-8：此前发 workspace 级团队会话 id，普通会话中派发时子行落团队会话，
   * 嵌套展开永远为空。v25 Task 15：团队会话字段删除，本参数成为唯一目标）。
   */
  executionSessionId?: string,
  /**
   * v1.5.1：PM chat loop 的 abortSignal。被 abort 时立即 reject（清理 pendingReplies），
   * 否则 PM 会阻塞到渐进式超时（3+6=9 分钟）才退出，期间停止按钮无效。
   */
  signal?: AbortSignal,
): Promise<{ body: string; toolCallsUsed: number }> {
  // dispatchOnce 恒调 onBuilt（本调用必给）——onBuilt 同步执行于发送前，
  // resultPromise 在 return 前必已赋值
  let resultPromise!: Promise<{ body: string; toolCallsUsed: number }>;
  dispatchOnce(subSlug, task, config, {
    toolBudget,
    subStreamSessionId,
    pmStreamSessionId,
    executionSessionId,
    traceLabel: '→ dispatch',
    onBuilt: (taskId) => {
      resultPromise = waitForTaskReply(
        taskId,
        subSlug,
        config,
        executionSessionId,
        subStreamSessionId,
        signal,
      );
    },
  });

  return resultPromise;
}

// === v2.8.0 T6：followup 执行体（dispatch_followup，spec §3） ===

/**
 * 链不存在 / 会话不匹配的统一文案（spec §13 错误表）。不区分「不存在」与
 * 「非自己派出」以省探测——所有权已由双重保证：(task_id, session_id) 双键
 * 过滤（他链会话的伪造行不命中）+ 会话边界校验（本会话成员 ∩ subAgents）。
 */
function chainNotFoundMsg(taskId: string): string {
  return `任务链 ${taskId} 不存在——仅可追问自己此前 dispatch 的任务`;
}

/**
 * followup 追问目标不可达的统一文案（链行存在但无法定位子 agent——
 * 链内无子 agent 消息行，或 sender 反查不到在册 assignment）。
 */
function targetUnresolvableMsg(taskId: string): string {
  return `任务链 ${taskId} 无法定位目标 agent，不能追问`;
}

/**
 * 主 agent 执行 dispatch_followup（v2.8.0 Orchestration spec §3）——对已
 * dispatch 的链追问（replay 续接）：
 *
 *   校验三连 → rebuildSubConversation 重建链历史 → 追问 user 行落库 →
 *   沿用原链 taskId 派发（body=question + history_prefix=重建前缀 + 新
 *   subStreamSessionId）→ 同步等 task_reply（waitForTaskReply 共用等待封装）。
 *
 * 校验三连（顺序即依赖序）：
 *   a. 链存在——messages 表 (task_id, session_id) 双键有行。executionSessionId
 *      缺失时无法安全定位链（所有权=会话边界），按链不存在处理。
 *   b. 同链无在途——pendingReplies 或 bgHandles(in_flight) 有该 taskId 即拒绝
 *      （spec §2.2 不变量 1：上轮 settle 后才可再 followup，pendingReplies 键
 *      安全）。bg done / cancelled 是终态，不阻塞。
 *   c. 会话边界——链首子消息 sender（子 agent 的 agentUserId）经
 *      workspace_agent_members 反查 assignment，在 config.subAgents 中匹配后
 *      走 assertSessionDispatchAllowed（既有单成员 / 跨会话 / 非 leader 拒绝）。
 *      为何 sender 反查而非直接取 dispatch_to：dispatch 内部事件是 transient
 *      进程内桥不落库，链首子消息无法直接携带目标——sender 是链行上唯一
 *      可证的目标痕迹（该轮执行者即子 agent 本身）。
 *
 * 降级（spec §3.1）：rebuildSubConversation degraded → history_prefix 缺席 +
 * body 前缀追加「（此前对话历史不可用）」提示（不阻断——子 agent 按带提示的
 * 全新任务处理）。落库的追问行保持用户原文（提示只注入派发 body，不污染链
 * 历史——后续轮次重建不受影响）。
 *
 * 打标闭环（T5）：派发 content.task_id = 原链 ID → routeDispatch 同值双设
 * TaskConfig.taskId = dispatchContext.task_id → start chunk 携带 → 新一轮子
 * 流行落库即带链标——链历史天然聚合。链 ID 无 tasks 表行，getTaskContext
 * 恒 null，无双重注入风险（T5 review 核实，无需防御）。
 *
 * 派发等待语义与 executeDispatch 完全一致（渐进式超时 3+6 分钟 + abortSignal
 * 即时清理），差异仅三处：taskId 沿用原链 ID（不 randomUUID）、content 多
 * history_prefix、发送前先落追问行。
 */
export async function executeFollowup(
  taskId: string,
  question: string,
  config: RuntimeConfig,
  executionSessionId?: string,
  signal?: AbortSignal,
  /**
   * PM 自身流 id——追问行 parent_stream_session_id 的来源（与 executeDispatch
   * 的 pmStreamSessionId 参数同源：工具调用上下文传入，renderer 据此把追问行
   * 定位到 PM 当前流的本轮工具调用区）。缺省空串（行仍带双键打标，重建不受影响）。
   */
  pmStreamSessionId?: string,
  /**
   * 本轮新子流 id——缺省自生成 randomUUID（spec §2.2 不变量 3：每轮新
   * subStreamSessionId，renderer DispatchChip 按它渲染新 chip）。工具层接线
   * 预生成时可透传（与 dispatch 工具的 chip 查找键机制对齐）。
   */
  subStreamSessionId?: string,
): Promise<{ body: string; toolCallsUsed: number }> {
  // --- 校验 a：链存在（(task_id, session_id) 双键） ---
  if (!executionSessionId) throw new Error(chainNotFoundMsg(taskId));
  const db = getDb();
  const chainExists = db
    .prepare('SELECT 1 AS ok FROM messages WHERE task_id = ? AND session_id = ? LIMIT 1')
    .get(taskId, executionSessionId);
  if (!chainExists) throw new Error(chainNotFoundMsg(taskId));

  // --- 校验 b：同链无在途轮次 ---
  if (pendingReplies.has(taskId) || bgHandles.get(taskId)?.status === 'in_flight') {
    throw new Error(`任务链 ${taskId} 上一轮仍在进行中——请等待子 agent 回复后再追问`);
  }

  // --- 校验 c：定位目标 agent + 会话边界 ---
  // 链首子消息 sender（子 agent 的 agentUserId，created_at 升序最早行）。
  // 不过滤 segment_of / roll 行——它们与流行同 sender，任取首行即可定位目标。
  const firstSubRow = db
    .prepare(
      `SELECT sender FROM messages
       WHERE task_id = ? AND session_id = ? AND sender != 'owner'
       ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    )
    .get(taskId, executionSessionId) as { sender: string } | undefined;
  if (!firstSubRow) throw new Error(targetUnresolvableMsg(taskId));
  const targetAssignment = db
    .prepare(
      'SELECT instance_id FROM workspace_agent_members WHERE agent_user_id = ? AND workspace_id = ?',
    )
    .get(firstSubRow.sender, config.workspaceId) as { instance_id: string } | undefined;
  const sub = config.subAgents.find((s) => s.assignmentId === targetAssignment?.instance_id);
  if (!sub) throw new Error(targetUnresolvableMsg(taskId));
  assertSessionDispatchAllowed(executionSessionId, config, sub.assignmentId);

  // --- 重建链历史（先于追问行落库——本轮 question 不进前缀，由 body 承载） ---
  const rebuilt = rebuildSubConversation(taskId, executionSessionId);
  let dispatchBody = question;
  if (rebuilt.degraded) {
    dispatchBody = `（此前对话历史不可用）\n${question}`;
  }

  // --- 追问 user 行落库（原文；双键打标供后续轮次重建聚合） ---
  appendFollowupQuestionRow(taskId, executionSessionId, pmStreamSessionId ?? '', question);

  // --- 派发：直接构造 content（不用 buildDispatchMessage——其 task_id 单点
  // randomUUID 生成，followup 必须沿用原链 ID；其余字段形态与之一致） ---
  const resolvedSubStream = subStreamSessionId ?? randomUUID();
  const content: DispatchContent = {
    body: dispatchBody,
    task_id: taskId,
    dispatch_from: config.agentAssignmentId,
    dispatch_to: sub.assignmentId,
    deadline_ms: DISPATCH_TOTAL_TIMEOUT_MS,
    ...(pmStreamSessionId ? { tool_stream_session_id: pmStreamSessionId } : {}),
    sub_stream_session_id: resolvedSubStream,
    // 空前缀（degraded / 链行无可聚合事件）不携带字段——T2 语义空数组等价无前缀
    ...(rebuilt.messages.length > 0 ? { history_prefix: rebuilt.messages } : {}),
  };

  trace('→ dispatch_followup', {
    target: sub.slug,
    chain: taskId,
    question: `${question.length}字`,
    rounds: rebuilt.rounds,
    degraded: rebuilt.degraded,
  });

  // 先注册等待态再发送（防竞态——同 executeDispatch 纪律）
  const resultPromise = waitForTaskReply(
    taskId,
    sub.slug,
    config,
    executionSessionId,
    resolvedSubStream,
    signal,
  );
  sendDispatchEvent(executionSessionId, config.agentUserId, { ...content });

  return resultPromise;
}

/**
 * 渐进式超时计时器管理：
 * stage 0 → 等待 3 分钟 → 超时则进入 stage 1
 * stage 1 → 等待 6 分钟 → 超时则最终判失败
 * 收到 in_progress 时调用此函数重置当前阶段计时器。
 */
function armDispatchTimer(taskId: string): void {
  const pending = pendingReplies.get(taskId);
  if (!pending) return;
  clearTimeout(pending.timer);
  const timeoutMs = DISPATCH_STAGE_TIMEOUTS_MS[pending.stage];
  if (timeoutMs === undefined) return;
    pending.timer = setTimeout(() => {
      if (pending.stage < DISPATCH_STAGE_TIMEOUTS_MS.length - 1) {
        pending.stage++;
        console.log(`[dispatch] 等待 ${pending.subSlug} 超时，进入第 ${pending.stage + 1} 阶段`, { taskId });
        armDispatchTimer(taskId);
      } else {
        pending.abortCleanup?.();
        pendingReplies.delete(taskId);
        const totalMin = Math.round(DISPATCH_TOTAL_TIMEOUT_MS / 60000);
        pending.reject(new Error(
          `等待子 agent ${pending.subSlug} 回复超时（已等待 ${totalMin} 分钟）。任务可能仍在后台执行，请直接查看该 agent 的回复。`,
        ));
      }
    }, timeoutMs);
  }

/**
 * 处理收到的 task_reply：若匹配某个 pending dispatch 则 resolve/reject 其 Promise。
 * in_progress → 进度通知，保持 pending（子 agent 处理中途合法地先发此状态）；
 * completed → resolve(body)；failed/needs_input → reject。
 */
export function handleTaskReply(content: Record<string, unknown>): void {
  const reply = parseTaskReply(content);
  if (!reply) return;
  const pending = pendingReplies.get(reply.task_id);
  if (!pending) {
    // v2.8.0 bg 分支（spec §4.2 单点收口）：pendingReplies miss → 查 bgHandles；
    // 既有同步 dispatch 在上方命中分支原样返回，零改动
    const bg = bgHandles.get(reply.task_id);
    if (bg) {
      if (bg.status === 'in_flight') {
        if (reply.status === 'in_progress') {
          // 进度通知：不 settle——与 pendingReplies 的 in_progress 语义一致（保持等待，gather waiter 不唤醒）
          return;
        }
        // 终态 reply（completed / failed / needs_input）→ 翻转 done + 结果缓存。
        // BgHandle 无 failed 态（spec §4.1 枚举三值）：失败 body 原样保留，gather 收割后由 LLM 自行判读
        bg.status = 'done';
        bg.body = reply.body;
        bg.toolCallsUsed = reply.tool_calls_used ?? 0;
        bg.completedAt = Date.now();
        wakeGatherWaiters(reply.task_id, bg);
      }
      // 非 in_flight（cancelled / done）→ cancel 后或已收割后的迟到 reply：保留既有终态、忽略 body（幂等）
      return;
    }
    console.warn(`[dispatch] 收到迟到的 task_reply（taskId=${reply.task_id}, status=${reply.status}）— 已超时或已处理`);
    return;
  }
  if (reply.status === 'in_progress') {
    trace('← reply: in_progress');
    armDispatchTimer(reply.task_id);
    return;
  }
  trace('← reply', { status: reply.status, body: `${reply.body.length}字` });
  // minor-10：settle 路径统一调 abortCleanup 移除 abortSignal 监听器——
  // 否则 reply 到达后若用户再触发 abort，onAbort 会再次执行（entry 已删，
  // 仍会误发 abort_dispatch 给不存在的子 agent）
  pending.abortCleanup?.();
  clearTimeout(pending.timer);
  pendingReplies.delete(reply.task_id);
  if (reply.status === 'completed') {
    pending.resolve({ body: reply.body, toolCallsUsed: reply.tool_calls_used ?? 0 });
  } else {
    pending.reject(new Error(`子 agent 回复状态 "${reply.status}": ${reply.body}`));
  }
}

/**
 * 消费主进程下发的 task-reply IPC 消息（AgentRunner.notifyTaskReply → child.send）。
 *
 * 消息体是 camelCase 的 TaskReplyNotification（RouterService 从 snake_case event
 * content 转换而来）；本函数转回 snake_case content 交给 handleTaskReply，
 * 由 pendingReplies 按 task_id 精确匹配并 resolve/reject 对应 dispatch promise。
 */
export function handleTaskReplyIpc(msg: unknown): void {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as {
    type?: string;
    reply?: {
      taskId?: string;
      status?: string;
      body?: string;
      progressPct?: number;
      toolCallsUsed?: number;
    };
  };
  if (m.type !== 'task-reply' || typeof m.reply?.taskId !== 'string') return;
  handleTaskReply({
    task_id: m.reply.taskId,
    status: m.reply.status ?? 'completed',
    body: m.reply.body ?? '',
    ...(m.reply.progressPct !== undefined ? { progress_pct: m.reply.progressPct } : {}),
    ...(m.reply.toolCallsUsed !== undefined ? { tool_calls_used: m.reply.toolCallsUsed } : {}),
  });
}

// === v2.8.0 T4：异步族执行体（dispatch_bg / gather / status / cancel，spec §4.2） ===

/**
 * 异步后台派发（dispatch_bg:<slug>）：与 executeDispatch 共用 dispatchOnce 派发链路
 * （会话边界门 + buildDispatchMessage + sendDispatchEvent），差异仅在等待态——
 * 不注册 pendingReplies，改注册 bgHandles（in_flight），立即返回 { taskId }。
 * taskId 即句柄（不另造 ID 空间）；reply 经 handleTaskReply 单点收口的 bg 分支翻转。
 */
export async function executeDispatchBg(
  subSlug: string,
  task: string,
  config: RuntimeConfig,
  toolBudget?: number,
  subStreamSessionId?: string,
  pmStreamSessionId?: string,
  executionSessionId?: string,
): Promise<{ taskId: string }> {
  // 在途上限（spec §4.2）：≥ BG_HANDLE_LIMIT → 报错含在途清单，教 LLM 先 gather/cancel
  const inFlight = listInFlightBg();
  if (inFlight.length >= BG_HANDLE_LIMIT) {
    const listing = inFlight.map((x) => `${x.taskId}(${x.slug})`).join('、');
    throw new Error(`在途后台任务已达上限（${BG_HANDLE_LIMIT}）：${listing}——请先 gather 或 cancel`);
  }
  const { taskId } = dispatchOnce(subSlug, task, config, {
    toolBudget,
    subStreamSessionId,
    pmStreamSessionId,
    executionSessionId,
    traceLabel: '→ dispatch_bg',
    onBuilt: (tid) => {
      // 先注册句柄，再发送——与同步路径 pendingReplies 同防竞态纪律
      bgHandles.set(tid, { slug: subSlug, status: 'in_flight', startedAt: Date.now(), subStreamSessionId });
    },
  });
  return { taskId };
}

/** gather 单条收割结果（快照副本——不持句柄引用，T3 review Minor 纪律） */
export interface GatherDoneEntry {
  taskId: string;
  status: string;
  body?: string;
  toolCallsUsed?: number;
}

/** executeGather 返回形状：done 已收割 / pending 仍在途 / notes 不存在句柄说明 */
export interface GatherResult {
  done: GatherDoneEntry[];
  pending: string[];
  notes: string[];
}

/** gather 超时钳制边界（spec §5）：下限 1s / 上限 10min */
const GATHER_TIMEOUT_MIN_MS = 1_000;
const GATHER_TIMEOUT_MAX_MS = 600_000;
/** gather 超时缺省 2min */
const GATHER_TIMEOUT_DEFAULT_MS = 120_000;

function clampGatherTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return GATHER_TIMEOUT_DEFAULT_MS;
  return Math.min(GATHER_TIMEOUT_MAX_MS, Math.max(GATHER_TIMEOUT_MIN_MS, Math.round(timeoutMs)));
}

/** 从句柄复制快照构造 done 条目（cancelled 恒无 body——spec §4.2） */
function snapshotDoneEntry(taskId: string, h: BgHandle): GatherDoneEntry {
  if (h.status === 'cancelled') return { taskId, status: 'cancelled' };
  return {
    taskId,
    status: h.status,
    ...(h.body !== undefined ? { body: h.body } : {}),
    ...(h.toolCallsUsed !== undefined ? { toolCallsUsed: h.toolCallsUsed } : {}),
  };
}

/**
 * 收割后台句柄（dispatch_gather）：
 * - 终态句柄（done / cancelled）立即收集；not_found 句柄进 notes 不整体失败
 * - in_flight 句柄注册 gatherWaiter，翻转（reply / cancel）即唤醒
 * - mode='all' 全部 settle 或超时；mode='any' 首个 settle 即返回
 * - 超时是正常返回（done + pending），句柄保留可再 gather——不删句柄（幂等）
 */
export async function executeGather(
  handles: string[],
  mode: 'all' | 'any',
  timeoutMs?: number,
): Promise<GatherResult> {
  const clampedMs = clampGatherTimeoutMs(timeoutMs);
  const done: GatherDoneEntry[] = [];
  const notes: string[] = [];

  // 同步首扫（与下方 waiter 注册同批同步执行——无窗口让 reply 插队）：
  // 输入去重保序；终态立即收（快照复制）；not_found 进 notes
  const seen = new Set<string>();
  const inFlightIds: string[] = [];
  for (const id of handles) {
    if (seen.has(id)) continue;
    seen.add(id);
    const h = bgHandles.get(id);
    if (!h) {
      notes.push(`句柄 ${id} 不存在（未派发或 runtime 已重启）`);
      continue;
    }
    if (h.status === 'in_flight') {
      inFlightIds.push(id);
      continue;
    }
    done.push(snapshotDoneEntry(id, h));
  }

  // 无需等待：all=已全部收割；any=已有 settle（或无在途）——立即返回不挂计时器
  if (inFlightIds.length === 0 || (mode === 'any' && done.length > 0)) {
    return { done, pending: mode === 'any' && done.length > 0 ? [...inFlightIds] : [], notes };
  }

  return await new Promise<GatherResult>((resolve) => {
    let finished = false;
    let settledCount = 0;
    const cleanups: Array<() => void> = [];
    // timer 在 waiter 注册之后才初始化；finish 闭包仅在其后才会被调用（waiter
    // 回调 / 超时回调），无 TDZ 风险
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const c of cleanups) c();
      // 仍在途的句柄进 pending（超时非错误——句柄保留可再 gather）
      const pending: string[] = [];
      for (const id of inFlightIds) {
        const h = bgHandles.get(id);
        if (h && h.status === 'in_flight') pending.push(id);
      }
      resolve({ done, pending, notes });
    };
    for (const id of inFlightIds) {
      cleanups.push(
        addGatherWaiter(id, (h) => {
          if (finished) return;
          done.push(snapshotDoneEntry(id, h));
          settledCount++;
          if (mode === 'any' || settledCount >= inFlightIds.length) finish();
        }),
      );
    }
    const timer = setTimeout(() => finish(), clampedMs);
  });
}

/** executeStatus 返回形状 */
export interface BgStatusResult {
  status: string;
  body?: string;
  toolCallsUsed?: number;
  elapsedMs?: number;
}

/** 查询单个后台句柄状态（dispatch_status）：not_found → 恰好 { status: 'not_found' } */
export function executeStatus(handle: string): BgStatusResult {
  const h = bgHandles.get(handle);
  if (!h) return { status: 'not_found' };
  if (h.status === 'in_flight') {
    return { status: 'in_flight', elapsedMs: Date.now() - h.startedAt };
  }
  return {
    status: h.status,
    elapsedMs: (h.completedAt ?? h.startedAt) - h.startedAt,
    ...(h.body !== undefined ? { body: h.body } : {}),
    ...(h.toolCallsUsed !== undefined ? { toolCallsUsed: h.toolCallsUsed } : {}),
  };
}

/**
 * 取消在途后台句柄（dispatch_cancel，幂等）：
 * - in_flight → 发 abort_dispatch（既有 routeAbortDispatch 链路，发送形态参照
 *   executeDispatch onAbort——subStreamSessionId 创建句柄时已存）+ 标 cancelled
 *   + 唤醒该句柄的 gather waiter（cancel 即 settle，all 模式不拖到超时）
 * - 已终态（done / cancelled）→ 幂等返回当前状态，不发事件
 * - not_found → { status: 'not_found' }（同 status 语义）
 */
export function executeCancel(
  handle: string,
  config: RuntimeConfig,
  executionSessionId?: string,
): { status: string } {
  const h = bgHandles.get(handle);
  if (!h) return { status: 'not_found' };
  if (h.status !== 'in_flight') return { status: h.status };
  const abortEvt = buildAbortDispatchMessage({ taskId: handle, subStreamSessionId: h.subStreamSessionId });
  sendAbortDispatchEvent(executionSessionId ?? '', config.agentUserId, abortEvt.content);
  h.status = 'cancelled';
  h.completedAt = Date.now();
  wakeGatherWaiters(handle, h);
  return { status: 'cancelled' };
}
