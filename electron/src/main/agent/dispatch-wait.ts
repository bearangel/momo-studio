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

import {
  buildDispatchMessage,
  buildAbortDispatchMessage,
  parseTaskReply,
} from './dispatch';
import { sendDispatchEvent, sendAbortDispatchEvent } from './internal-event';
import type { RuntimeConfig } from './runtime-config';

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

// === Dispatch：主 agent 等待子 agent 回执 ===

interface PendingReply {
  /** v1.4：resolve 携带 body + toolCallsUsed，供主 agent 扣减共享预算 */
  resolve: (value: { body: string; toolCallsUsed: number }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  stage: number;
  subSlug: string;
}

/** pending dispatch 回执：task_id → 等待中的 Promise（主 agent 发出 dispatch 后注册） */
const pendingReplies = new Map<string, PendingReply>();

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
   * （P0-8：此前发 config.teamSessionId，普通会话中派发时子行落团队会话，
   * 嵌套展开永远为空）。
   */
  executionSessionId?: string,
  /**
   * v1.5.1：PM chat loop 的 abortSignal。被 abort 时立即 reject（清理 pendingReplies），
   * 否则 PM 会阻塞到渐进式超时（3+6=9 分钟）才退出，期间停止按钮无效。
   */
  signal?: AbortSignal,
): Promise<{ body: string; toolCallsUsed: number }> {
  const sub = config.subAgents.find((s) => s.slug === subSlug);
  if (!sub) throw new Error(`未知子 agent: ${subSlug}`);

  trace('→ dispatch', { target: subSlug, task: `${task.length}字`, budget: toolBudget });

  // v2（Task 10）：from/to 均为 assignmentId——RouterService 直接以此定位 runner
  const dispatch = buildDispatchMessage({
    body: task,
    fromAssignmentId: config.agentAssignmentId,
    toAssignmentId: sub.assignmentId,
    deadlineMs: DISPATCH_TOTAL_TIMEOUT_MS,
    toolBudget,
    toolStreamSessionId: pmStreamSessionId,
    subStreamSessionId,
  });

  // 先注册 pending，再发送——防竞态
  const resultPromise = new Promise<{ body: string; toolCallsUsed: number }>((resolve, reject) => {
    pendingReplies.set(dispatch.content.task_id, {
      resolve,
      reject,
      timer: setTimeout(() => {}, 0), // 占位，armDispatchTimer 会替换
      stage: 0,
      subSlug,
    });
    armDispatchTimer(dispatch.content.task_id);

    // v1.5.1：监听 abortSignal，被中断时立即清理 + reject（不等渐进式超时）
    if (signal) {
      const onAbort = (): void => {
        const entry = pendingReplies.get(dispatch.content.task_id);
        if (entry) {
          clearTimeout(entry.timer);
          pendingReplies.delete(dispatch.content.task_id);
        }
        // 发 abort_dispatch 内部事件兜底通知子 agent——子 agent 此刻可能尚未启动，
        // 主进程 abortStream 找不到它。事件桥是 transient 进程内桥（路由表在
        // RouterService.runners Map），未启动的子 agent 收不到此事件；兜底是
        // PM 侧 onAbort 立即 reject + 子 agent 自身渐进式超时（3+6=9 分钟）
        // 自然收敛——而非依赖事件桥把 abort 投递到后续启动的子 agent。
        const abortEvt = buildAbortDispatchMessage({
          taskId: dispatch.content.task_id,
          subStreamSessionId: subStreamSessionId,
        });
        sendAbortDispatchEvent(executionSessionId ?? config.teamSessionId, config.agentUserId, abortEvt.content);
        const err = new Error('dispatch 被中断');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  // sender 携带 agent 本地身份 agentUserId（Task 10）。展开 DispatchContent 为
  // 匿名对象类型以满足内部事件协议的 Record<string, unknown> 索引签名。
  sendDispatchEvent(executionSessionId ?? config.teamSessionId, config.agentUserId, { ...dispatch.content });

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
    console.warn(`[dispatch] 收到迟到的 task_reply（taskId=${reply.task_id}, status=${reply.status}）— 已超时或已处理`);
    return;
  }
  if (reply.status === 'in_progress') {
    trace('← reply: in_progress');
    armDispatchTimer(reply.task_id);
    return;
  }
  trace('← reply', { status: reply.status, body: `${reply.body.length}字` });
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
