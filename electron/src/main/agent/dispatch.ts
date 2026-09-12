// electron/src/main/agent/dispatch.ts
//
// Dispatch / Task Reply 消息类型 — 主子 agent 的任务调度指令与回执。
// v2（P1 Task 5）：经 child IPC 内部事件桥传输（事件类型名沿用 Matrix 命名）。
// v2（Task 10）：dispatch_from / dispatch_to / reply_to 的值从 Matrix userId 改为
// assignmentId——内容字段名保持不变（对路由层是透明字符串）。
// 纯函数模块，不持有任何外部副作用，便于单测。

import { randomUUID } from 'node:crypto';
import type { LLMMessage, LLMToolCall } from './llm-provider';

/** dispatch 消息内容（v2 Task 10 起经内部事件桥传输）。dispatch_from/dispatch_to 的值是 assignmentId */
export interface DispatchContent {
  body: string;
  task_id: string;
  dispatch_from: string;
  dispatch_to: string;
  deadline_ms?: number;
  /** v1.4：传给子 agent 的工具调用预算（-1=无限，0=禁用，N=上限） */
  tool_budget?: number;
  /**
   * PM 自身流 id——子 agent 消息行 parent_stream_session_id 的来源
   * （renderer 据此把子 agent 消息过滤出顶层列表 + 表达嵌套归属）。
   */
  tool_stream_session_id?: string;
  /**
   * 子 agent 自身流 id——PM 在 dispatch tool_call chunk 预生成并携带
   * （isDispatch.subStreamSessionId）。routeDispatch 用它作 task.streamSessionId，
   * 保证子 agent 消息行的 stream_session_id 与 renderer chip 的查找键一致
   * （P0-7：此前 routeDispatch 自造新 UUID，嵌套展开区永远找不到子流）。
   */
  sub_stream_session_id?: string;
  /**
   * v2.8.0 Orchestration（Task 6）：followup 续聊前缀——executeFollowup 把
   * rebuildSubConversation 重建的子会话历史放此处随 dispatch 事件传输，
   * routeDispatch 映射为 TaskConfig.historyPrefix（子 agent runChatLoop 拼接在
   * system 之后、新 user 轮之前）。仅 followup 派发设置；普通 dispatch 缺席。
   */
  history_prefix?: LLMMessage[];
}

/** task_reply 消息内容（Matrix event type: io.momo-studio.task_reply） */
export interface TaskReplyContent {
  body: string;
  task_id: string;
  status: 'in_progress' | 'completed' | 'failed' | 'needs_input';
  progress_pct?: number;
  /** v1.4：子 agent 报告本任务使用的工具调用次数 */
  tool_calls_used?: number;
  /** v2（I2 修复）：目标 PM 的 botUserId，用于 RouterService 精确路由（避免广播）。
   * 缺省时 RouterService 回退到广播所有 runner（向后兼容旧 task_reply event）。 */
  reply_to?: string;
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

/** 构造一条 dispatch 消息：自动生成 task_id（UUID v4）。from/to 均传 assignmentId */
export function buildDispatchMessage(opts: {
  body: string;
  fromAssignmentId: string;
  toAssignmentId: string;
  deadlineMs?: number;
  /** v1.4：传给子 agent 的工具调用预算（-1=无限，0=禁用，N=上限） */
  toolBudget?: number;
  /** PM 自身流 id（子消息 parentStreamSessionId 的来源） */
  toolStreamSessionId?: string;
  /** 子 agent 自身流 id（PM 在 dispatch tool_call chunk 预生成；routeDispatch 用作 task.streamSessionId） */
  subStreamSessionId?: string;
}): { eventType: typeof DISPATCH_EVENT_TYPE; content: DispatchContent } {
  return {
    eventType: DISPATCH_EVENT_TYPE,
    content: {
      body: opts.body,
      task_id: randomUUID(),
      dispatch_from: opts.fromAssignmentId,
      dispatch_to: opts.toAssignmentId,
      deadline_ms: opts.deadlineMs,
      tool_budget: opts.toolBudget,
      tool_stream_session_id: opts.toolStreamSessionId,
      sub_stream_session_id: opts.subStreamSessionId,
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
  /** v2（I2 修复）：目标 PM 的 assignmentId，用于精确路由 */
  replyTo?: string;
}): { eventType: typeof TASK_REPLY_EVENT_TYPE; content: TaskReplyContent } {
  return {
    eventType: TASK_REPLY_EVENT_TYPE,
    content: {
      body: opts.body,
      task_id: opts.taskId,
      status: opts.status,
      progress_pct: opts.progressPct,
      tool_calls_used: opts.toolCallsUsed,
      ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
    },
  };
}

/** 从 Matrix event content 解析 dispatch；缺关键字段或类型不符时返回 null。
 *
 * minor-9 修复：旧实现只校验 task_id / body 必填，其余字段直接 `as` 强转——
 * 缺 dispatch_from / dispatch_to 时下游 routeDispatch 把 undefined 当成
 * runners Map key 查找，错误路由静默丢弃。要求必填字段全部 typeof string；
 * 可选字段类型不符时按 undefined 丢弃（不连带整条拒绝，避免对端写脏字段把
 * 整条 dispatch 吞掉）。 */
export function parseDispatchEvent(content: Record<string, unknown>): DispatchContent | null {
  if (typeof content.task_id !== 'string') return null;
  if (typeof content.body !== 'string') return null;
  if (typeof content.dispatch_from !== 'string') return null;
  if (typeof content.dispatch_to !== 'string') return null;
  const historyPrefix = parseHistoryPrefix(content.history_prefix);
  return {
    body: content.body,
    task_id: content.task_id,
    dispatch_from: content.dispatch_from,
    dispatch_to: content.dispatch_to,
    ...(typeof content.deadline_ms === 'number'
      ? { deadline_ms: content.deadline_ms }
      : {}),
    ...(typeof content.tool_budget === 'number'
      ? { tool_budget: content.tool_budget }
      : {}),
    ...(typeof content.tool_stream_session_id === 'string'
      ? { tool_stream_session_id: content.tool_stream_session_id }
      : {}),
    ...(typeof content.sub_stream_session_id === 'string'
      ? { sub_stream_session_id: content.sub_stream_session_id }
      : {}),
    ...(historyPrefix !== undefined ? { history_prefix: historyPrefix } : {}),
  };
}

/** LLMMessage.role 合法枚举（与 llm-provider LLMMessage 同步） */
const VALID_PREFIX_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * 校验 history_prefix 载荷（v2.8.0 Task 6）：数组且每条 {role 枚举内, content string}
 * 才返回；否则 undefined（整字段丢弃——半截历史比没有历史更危险，降级方向安全）。
 * 工具对字段（C1 修复）：assistant.toolCalls / tool.toolCallId 与 LLMMessage 对齐
 * 校验后 verbatim 保留——剥离会让 followup 后子 agent 首次 LLM 请求携带孤儿
 * tool result（无 tool_call_id），OpenAI/Anthropic 方言均硬拒（spec §3.3
 * 「完整工具对 verbatim 保留」）。toolCallId 非 string → 仅丢该字段；
 * toolCalls 任一项非法 → 整字段丢弃（不半保留——半对即孤儿）。
 * 生产者 executeFollowup / 消费者 routeDispatch（映射 TaskConfig.historyPrefix）共用。
 */
export function parseHistoryPrefix(raw: unknown): LLMMessage[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: LLMMessage[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return undefined;
    const r = item as { role?: unknown; content?: unknown; toolCallId?: unknown; toolCalls?: unknown };
    if (typeof r.role !== 'string' || !VALID_PREFIX_ROLES.has(r.role)) return undefined;
    if (typeof r.content !== 'string') return undefined;
    const toolCalls = parsePrefixToolCalls(r.toolCalls);
    out.push({
      role: r.role as LLMMessage['role'],
      content: r.content,
      ...(typeof r.toolCallId === 'string' ? { toolCallId: r.toolCallId } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
    });
  }
  return out;
}

/**
 * 校验前缀里的 assistant.toolCalls：数组且每项 {id: string, name: string}
 * （arguments 保留原值不校验——生产者聚合器恒产 Record，对端脏值序列化无害）；
 * 任一项非法返回 undefined（整字段丢弃——保留半截列表等于制造孤儿 tool result）。
 */
function parsePrefixToolCalls(raw: unknown): LLMToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const calls: LLMToolCall[] = [];
  for (const tc of raw) {
    if (typeof tc !== 'object' || tc === null) return undefined;
    const t = tc as { id?: unknown; name?: unknown; arguments?: unknown };
    if (typeof t.id !== 'string' || typeof t.name !== 'string') return undefined;
    calls.push({ id: t.id, name: t.name, arguments: t.arguments as Record<string, unknown> });
  }
  return calls;
}

/** 合法 task_reply 状态枚举——与 TaskReplyContent['status'] 同步 */
const VALID_REPLY_STATUSES: ReadonlySet<TaskReplyContent['status']> = new Set([
  'in_progress',
  'completed',
  'failed',
  'needs_input',
]);

/** 从 Matrix event content 解析 task_reply；缺关键字段或类型不符时返回 null。
 *
 * minor-9：status 必须命中合法枚举——否则下游 pendingReplies 在 handleTaskReply
 * 里把所有非法 status 走 reject 分支（completed 之外都是 reject），构造者
 * 若写了 'success'/'done'/'finished' 等非法值会被静默判失败。 */
export function parseTaskReply(content: Record<string, unknown>): TaskReplyContent | null {
  if (typeof content.task_id !== 'string') return null;
  if (typeof content.body !== 'string') return null;
  if (typeof content.status !== 'string') return null;
  if (!VALID_REPLY_STATUSES.has(content.status as TaskReplyContent['status'])) return null;
  return {
    body: content.body,
    task_id: content.task_id,
    status: content.status as TaskReplyContent['status'],
    ...(typeof content.progress_pct === 'number'
      ? { progress_pct: content.progress_pct }
      : {}),
    ...(typeof content.tool_calls_used === 'number'
      ? { tool_calls_used: content.tool_calls_used }
      : {}),
    ...(typeof content.reply_to === 'string' ? { reply_to: content.reply_to } : {}),
  };
}