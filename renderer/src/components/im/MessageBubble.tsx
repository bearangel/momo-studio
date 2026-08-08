// renderer/src/components/im/MessageBubble.tsx
//
// 单条消息渲染入口。根据eventType 分发：
//   - io.momo-studio.dispatch   → DispatchCard（紫色，走 MessageFrame）
//   - io.momo-studio.task_reply → TaskReplyCard（状态色，走 MessageFrame）
//   - 其余（m.room.message 等）   → 普通气泡（走 MessageFrame，自己蓝/他人灰）
// 三类消息统一走 MessageFrame 外壳，视觉一致、归属统一。
// 消息体统一用 react-markdown 渲染（支持 GFM 表格、删除线等）。
//
// v1.4：普通 m.room.message 若含 io.momo-studio.thinking / io.momo-studio.tool_calls
//   持久化字段（agent 最终回复由 runtime sendFinalMessage 写入），渲染增强气泡——
//   ThinkingSection + ToolCallChip 列表 + 正文，视觉与 AgentStreamBubble 完成态一致。
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImMessage, TodoItem } from '../../ipc/types';
import { ipc } from '../../ipc/client';
import type { DispatchChild, StreamState } from '../../stores/stream.store';
import { useStreamStore } from '../../stores/stream.store';
import { cn } from '../../lib/cn';
import { DispatchCard } from './DispatchCard';
import { DispatchChip } from './DispatchChip';
import { TaskReplyCard } from './TaskReplyCard';
import { MessageFrame } from './MessageFrame';
import { ThinkingSection } from './ThinkingSection';
import { ToolCallChip } from './ToolCallChip';

interface Props {
  message: ImMessage;
  isSelf: boolean;
  /** bot 的配置名称（如有），优先于 shortName 展示 */
  senderName?: string;
  /** 同房间的全部消息（用于从 Matrix 历史重建子 agent StreamState） */
  allMessages?: ImMessage[];
}

/** agent 持久化到 Matrix 消息的单条工具调用记录（与 electron 端 ToolCallRecord 对齐） */
interface PersistedToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
  /** v1.4 嵌套：标记为 PM 的 dispatch 委派（渲染为 DispatchChip 而非 ToolCallChip） */
  isDispatch?: boolean;
  /** v1.4 嵌套：子 agent 流式 session ID（关联到 dispatch chip） */
  subStreamSessionId?: string;
  /** v1.4 嵌套：子 agent 展示名 */
  subAgentName?: string;
  /** v1.4 嵌套：子 agent emoji 头像 */
  subAgentAvatar?: string;
}

/** Matrix event content 中的 io.momo-studio.* 自定义键 */
const THINKING_KEY = 'io.momo-studio.thinking';
const TOOL_CALLS_KEY = 'io.momo-studio.tool_calls';
const TODOS_KEY = 'io.momo-studio.todos';
/** v1.5.5：dispatch 单独持久化字段（不被 fitEventContent 4级截断删除） */
const DISPATCHES_KEY = 'io.momo-studio.dispatches';

/**
 * 从 Matrix event content 安全提取 agent 持久化字段。
 * content 是 Record<string, unknown>，需逐字段做类型收窄，避免脏数据导致渲染崩溃。
 * 返回的 thinking 为字符串（空串表示无），toolCalls 为已校验的数组（空数组表示无）。
 */
function extractAgentMeta(content: Record<string, unknown>): {
  thinking: string;
  toolCalls: PersistedToolCall[];
} {
  const rawThinking = content[THINKING_KEY];
  const thinking = typeof rawThinking === 'string' ? rawThinking : '';

  const rawToolCalls = content[TOOL_CALLS_KEY];
  if (!Array.isArray(rawToolCalls)) {
    return { thinking, toolCalls: [] };
  }
  // 逐条校验结构：必须有 name 字符串 + args 对象 + result 字符串 + success 布尔
  const toolCalls: PersistedToolCall[] = [];
  for (const item of rawToolCalls) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const name = obj.name;
    const args = obj.args;
    const result = obj.result;
    const success = obj.success;
    if (
      typeof name === 'string' &&
      typeof result === 'string' &&
      typeof success === 'boolean' &&
      typeof args === 'object' &&
      args !== null &&
      !Array.isArray(args)
    ) {
      // v1.4 嵌套：提取 dispatch 元数据（可选字段，类型守卫后写入）
      const isDispatch = obj.isDispatch === true ? true : undefined;
      const subStreamSessionId =
        typeof obj.subStreamSessionId === 'string' ? obj.subStreamSessionId : undefined;
      const subAgentName =
        typeof obj.subAgentName === 'string' ? obj.subAgentName : undefined;
      const subAgentAvatar =
        typeof obj.subAgentAvatar === 'string' ? obj.subAgentAvatar : undefined;
      toolCalls.push({
        name,
        args: args as Record<string, unknown>,
        result,
        success,
        isDispatch,
        subStreamSessionId,
        subAgentName,
        subAgentAvatar,
      });
    }
  }
  return { thinking, toolCalls };
}

/**
 * v1.5：从 Matrix event content 安全提取 io.momo-studio.todos 字段。
 * 逐条校验 id/subject 字符串 + status 枚举值，避免脏数据导致渲染崩溃。
 */
function extractTodos(content: Record<string, unknown>): TodoItem[] {
  const raw = content[TODOS_KEY];
  if (!Array.isArray(raw)) return [];
  const todos: TodoItem[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const id = obj.id;
    const subject = obj.subject;
    const status = obj.status;
    if (
      typeof id === 'string' &&
      typeof subject === 'string' &&
      (status === 'pending' || status === 'in_progress' || status === 'completed')
    ) {
      todos.push({ id, subject, status });
    }
  }
  return todos;
}

/**
 * 从 Matrix 历史消息重建子 agent 的 StreamState（重启后 stream Map 为空时的 fallback）。
 * 从子 agent 的 m.room.message 中提取 thinking / tool_calls / body，
 * 构造一个 status='done' 的只读 StreamState 供 DispatchChip 展示。
 */
function buildStreamFromMessage(msg: ImMessage, subStreamSessionId: string): StreamState {
  const { thinking, toolCalls } = extractAgentMeta(msg.content);
  // v1.5.7: 从历史消息重建时间线事件流——按 thinking → tool_calls → text 顺序
  const events: StreamState['events'] = [];
  if (thinking) {
    events.push({ id: crypto.randomUUID(), type: 'thinking', content: thinking });
  }
  for (const tc of toolCalls) {
    events.push({
      id: crypto.randomUUID(),
      type: 'tool_call',
      toolName: tc.name,
      args: tc.args,
      result: tc.result,
      success: tc.success,
      isExecuting: false,
      ...(tc.isDispatch ? {
        isDispatch: true,
        subStreamSessionId: tc.subStreamSessionId,
        subAgentName: tc.subAgentName,
      } : {}),
    });
  }
  if (msg.body) {
    events.push({ id: crypto.randomUUID(), type: 'text', content: msg.body });
  }
  const extractedTodos = extractTodos(msg.content);
  if (extractedTodos.length > 0) {
    events.push({ id: crypto.randomUUID(), type: 'todo', todos: extractedTodos });
  }
  return {
    streamSessionId: subStreamSessionId,
    roomId: msg.roomId,
    botUserId: msg.sender,
    thinking,
    text: msg.body,
    toolCalls: toolCalls.map((tc) => ({
      toolName: tc.name,
      args: tc.args,
      result: tc.result,
      success: tc.success,
      isExecuting: false,
    })),
    status: 'done',
    dispatchChildren: [],
    todos: extractedTodos,
    startedAt: msg.timestamp,
    events,
  };
}

/** 判断持久化的 tool call 是否为 dispatch 委派（显式标记或 name 前缀 dispatch:） */
function isDispatchToolCall(tc: PersistedToolCall): boolean {
  return tc.isDispatch === true || tc.name.startsWith('dispatch:');
}

/**
 * 从持久化的 dispatch tool call 构造 DispatchChip 所需的 DispatchChild（历史模式）。
 * 历史期无实时 StreamState，status 由 success 推导；subAgentName 缺失时从
 * dispatch:<slug> 名推导，subStreamSessionId 缺失时用稳定占位 key。
 */
function buildHistoryDispatchChild(tc: PersistedToolCall, index: number): DispatchChild {
  const slug = tc.name.startsWith('dispatch:')
    ? tc.name.slice('dispatch:'.length)
    : tc.name;
  return {
    subStreamSessionId: tc.subStreamSessionId ?? `hist-dispatch-${index}`,
    subAgentName: tc.subAgentName ?? slug,
    subAgentAvatar: tc.subAgentAvatar,
    status: tc.success ? 'completed' : 'failed',
  };
}

/**
 * v1.5.5：从 io.momo-studio.dispatches 字段提取 dispatch 列表。
 * 该字段独立于 tool_calls，fitEventContent 4级截断删除 tool_calls 时不会丢失。
 * 返回 PersistedToolCall[] 形状以复用 buildHistoryDispatchChild 逻辑。
 */
function extractDispatchesField(content: Record<string, unknown>): PersistedToolCall[] {
  const raw = content[DISPATCHES_KEY];
  if (!Array.isArray(raw)) return [];
  const result: PersistedToolCall[] = [];
  raw.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) return;
    const d = item as {
      name?: unknown;
      success?: unknown;
      subStreamSessionId?: unknown;
      subAgentName?: unknown;
      subAgentAvatar?: unknown;
    };
    if (typeof d.name !== 'string') return;
    result.push({
      name: d.name,
      args: {},
      result: '',
      success: d.success !== false,
      isDispatch: true,
      ...(typeof d.subStreamSessionId === 'string' ? { subStreamSessionId: d.subStreamSessionId } : {}),
      ...(typeof d.subAgentName === 'string' ? { subAgentName: d.subAgentName } : {}),
      ...(typeof d.subAgentAvatar === 'string' ? { subAgentAvatar: d.subAgentAvatar } : {}),
      // 无 subStreamSessionId 时用稳定占位（与 buildHistoryDispatchChild 一致）
      ...(typeof d.subStreamSessionId !== 'string' ? { subStreamSessionId: `hist-dispatch-field-${i}` } : {}),
    });
  });
  return result;
}

export function MessageBubble({ message, isSelf, senderName, allMessages }: Props) {
  const streams = useStreamStore((s) => s.streams);

  // v1.5.7: 异步加载 agent_meta（持久化分层时 thinking/tool_calls 在 SQLite 而非 Matrix event）
  const metaId = message.content?.['io.momo-studio.agent_meta_id'];
  const [agentMeta, setAgentMeta] = useState<{ thinking: string; toolCalls: PersistedToolCall[] } | null>(null);

  useEffect(() => {
    if (typeof metaId !== 'string') return;
    let cancelled = false;
    ipc.agent.getMeta(metaId).then((m) => {
      if (cancelled || !m) return;
      try {
        setAgentMeta({
          thinking: m.thinking ?? '',
          toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) as PersistedToolCall[] : [],
        });
      } catch {
        // JSON 解析失败降级到 Matrix event 字段
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [metaId]);

  if (message.eventType === 'io.momo-studio.dispatch') {
    return <DispatchCard message={message} isSelf={isSelf} senderName={senderName} />;
  }
  if (message.eventType === 'io.momo-studio.task_reply') {
    return <TaskReplyCard message={message} isSelf={isSelf} senderName={senderName} />;
  }

  // 检测 agent 持久化字段：优先用 agent_meta（SQLite），否则用 Matrix event 内嵌字段
  const eventMeta = extractAgentMeta(message.content);
  const thinking = agentMeta?.thinking ?? eventMeta.thinking;
  const toolCalls = agentMeta?.toolCalls ?? eventMeta.toolCalls;
  const hasDispatchesField = extractDispatchesField(message.content).length > 0;
  const hasMetaId = typeof metaId === 'string';
  const hasAgentMeta = thinking.length > 0 || toolCalls.length > 0 || hasDispatchesField || hasMetaId;

  if (hasAgentMeta) {
    // v1.4 嵌套：分离 dispatch 委派与普通工具调用——前者渲染为 DispatchChip（历史模式，
    // 无实时 StreamState，仅展示完成/失败状态），后者保持 ToolCallChip 行为
    const regularToolCalls = toolCalls.filter((tc) => !isDispatchToolCall(tc));
    // v1.5.5：优先读独立的 dispatches 字段（不被 PDU 截断）；
    // 旧消息（v1.5.5 前）没有此字段，fallback 从 tool_calls 提取
    const dispatchFieldCalls = extractDispatchesField(message.content);
    const dispatchToolCalls =
      dispatchFieldCalls.length > 0
        ? dispatchFieldCalls
        : toolCalls.filter(isDispatchToolCall);

    // 增强气泡：与 AgentStreamBubble 完成态视觉一致（灰底 + 边框）
    return (
      <MessageFrame
        sender={message.sender}
        isSelf={isSelf}
        senderName={senderName}
        bubbleClassName="bg-bg-tertiary text-neutral-100 border border-border-subtle"
      >
        {thinking && <ThinkingSection content={thinking} />}
        {regularToolCalls.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            {regularToolCalls.map((tc, i) => (
              <ToolCallChip
                key={`${tc.name}-${i}`}
                toolName={tc.name}
                args={tc.args}
                result={tc.result}
                success={tc.success}
                defaultExpanded={false}
              />
            ))}
          </div>
        )}
        {/* v1.4 嵌套：dispatch chips — 优先从 streams Map 查找实时 StreamState，
            重启后从 Matrix 历史消息重建（按 parent_stream_session_id 匹配子 agent 消息） */}
        {dispatchToolCalls.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            {dispatchToolCalls.map((tc, i) => {
              const child = buildHistoryDispatchChild(tc, i);
              const liveStream = streams.get(child.subStreamSessionId);
              const historyChildMsg = allMessages?.find(
                (m) => m.content?.['io.momo-studio.parent_stream_session_id'] === child.subStreamSessionId,
              );
              const subStream = liveStream
                ?? (historyChildMsg ? buildStreamFromMessage(historyChildMsg, child.subStreamSessionId) : undefined);
              return (
                <DispatchChip
                  key={child.subStreamSessionId}
                  child={child}
                  subStream={subStream}
                />
              );
            })}
          </div>
        )}
        {/* 正文：与普通气泡一致的 markdown 渲染样式 */}
        <div className="[&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:bg-black/30">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown>
        </div>
      </MessageFrame>
    );
  }

  // 普通气泡（现有行为，未改动）
  return (
    <MessageFrame
      sender={message.sender}
      isSelf={isSelf}
      senderName={senderName}
      bubbleClassName={cn(isSelf ? 'bg-accent-blue text-white' : 'bg-bg-tertiary text-neutral-100')}
    >
      {/* react-markdown 渲染消息体；p 元素默认有 margin，用样式覆盖 */}
      <div className="[&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:bg-black/30">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown>
      </div>
    </MessageFrame>
  );
}
