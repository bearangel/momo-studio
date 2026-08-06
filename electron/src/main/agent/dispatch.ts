// electron/src/main/agent/dispatch.ts
//
// Dispatch / Task Reply 消息类型 — 主子 agent 通过 Matrix 自定义事件
// （io.momo-studio.dispatch / io.momo-studio.task_reply）传递任务调度指令与回执。
// 纯函数模块，不持有任何外部副作用，便于单测。

import { randomUUID } from 'node:crypto';

/** dispatch 消息内容（Matrix event type: io.momo-studio.dispatch） */
export interface DispatchContent {
  body: string;
  task_id: string;
  dispatch_from: string;
  dispatch_to: string;
  deadline_ms?: number;
  /** v1.4：传给子 agent 的工具调用预算（-1=无限，0=禁用，N=上限） */
  tool_budget?: number;
  /** v1.4 嵌套：子 agent 流式 session ID，用于关联 PM 气泡内的嵌套展示 */
  tool_stream_session_id?: string;
}

/** task_reply 消息内容（Matrix event type: io.momo-studio.task_reply） */
export interface TaskReplyContent {
  body: string;
  task_id: string;
  status: 'in_progress' | 'completed' | 'failed' | 'needs_input';
  progress_pct?: number;
  /** v1.4：子 agent 报告本任务使用的工具调用次数 */
  tool_calls_used?: number;
}

export const DISPATCH_EVENT_TYPE = 'io.momo-studio.dispatch';
export const TASK_REPLY_EVENT_TYPE = 'io.momo-studio.task_reply';
/**
 * v1.5.3：PM 中断 dispatch 时发此 event 到 team room。
 * 子 agent 在 handleDispatch 期间监听此 event 匹配 task_id，触发本地 abortController。
 * 解决时序竞态：abortStream 走 IPC（同步），但子 agent 此时可能还没启动 + 注册到 activeStreams，
 * 主进程找不到它；Matrix event 持久化，子 agent 后续启动时也能收到。
 */
export const ABORT_DISPATCH_EVENT_TYPE = 'io.momo-studio.abort_dispatch';

/** 构造一条 abort_dispatch 消息（PM 中断时通知子 agent 终止） */
export function buildAbortDispatchMessage(opts: {
  taskId: string;
  /** v1.4 嵌套：子 agent 流 session ID（便于子 agent 多任务场景下精确匹配） */
  subStreamSessionId?: string;
}): { eventType: typeof ABORT_DISPATCH_EVENT_TYPE; content: { task_id: string; sub_stream_session_id?: string } } {
  return {
    eventType: ABORT_DISPATCH_EVENT_TYPE,
    content: {
      task_id: opts.taskId,
      ...(opts.subStreamSessionId ? { sub_stream_session_id: opts.subStreamSessionId } : {}),
    },
  };
}

/** 构造一条 dispatch 消息：自动生成 task_id（UUID v4） */
export function buildDispatchMessage(opts: {
  body: string;
  fromBotUserId: string;
  toBotUserId: string;
  deadlineMs?: number;
  /** v1.4：传给子 agent 的工具调用预算（-1=无限，0=禁用，N=上限） */
  toolBudget?: number;
  /** v1.4 嵌套：子 agent 流式 session ID（关联到 PM 气泡的 dispatch chip） */
  toolStreamSessionId?: string;
}): { eventType: typeof DISPATCH_EVENT_TYPE; content: DispatchContent } {
  return {
    eventType: DISPATCH_EVENT_TYPE,
    content: {
      body: opts.body,
      task_id: randomUUID(),
      dispatch_from: opts.fromBotUserId,
      dispatch_to: opts.toBotUserId,
      deadline_ms: opts.deadlineMs,
      tool_budget: opts.toolBudget,
      tool_stream_session_id: opts.toolStreamSessionId,
    },
  };
}

/** 构造一条 task_reply 消息：task_id 必须与对应 dispatch 一致 */
export function buildTaskReply(opts: {
  body: string;
  taskId: string;
  status: TaskReplyContent['status'];
  progressPct?: number;
  /** v1.4：子 agent 报告本任务使用的工具调用次数 */
  toolCallsUsed?: number;
}): { eventType: typeof TASK_REPLY_EVENT_TYPE; content: TaskReplyContent } {
  return {
    eventType: TASK_REPLY_EVENT_TYPE,
    content: {
      body: opts.body,
      task_id: opts.taskId,
      status: opts.status,
      progress_pct: opts.progressPct,
      tool_calls_used: opts.toolCallsUsed,
    },
  };
}

/** 从 Matrix event content 解析 dispatch；缺关键字段时返回 null */
export function parseDispatchEvent(content: Record<string, unknown>): DispatchContent | null {
  if (typeof content.task_id !== 'string') return null;
  if (typeof content.body !== 'string') return null;
  return {
    body: content.body,
    task_id: content.task_id,
    dispatch_from: content.dispatch_from as string,
    dispatch_to: content.dispatch_to as string,
    deadline_ms: content.deadline_ms as number | undefined,
    tool_budget: content.tool_budget as number | undefined,
    tool_stream_session_id: content.tool_stream_session_id as string | undefined,
  };
}

/** 从 Matrix event content 解析 task_reply；缺关键字段时返回 null */
export function parseTaskReply(content: Record<string, unknown>): TaskReplyContent | null {
  if (typeof content.task_id !== 'string') return null;
  if (typeof content.body !== 'string') return null;
  return {
    body: content.body,
    task_id: content.task_id,
    status: content.status as TaskReplyContent['status'],
    progress_pct: content.progress_pct as number | undefined,
    tool_calls_used: content.tool_calls_used as number | undefined,
  };
}