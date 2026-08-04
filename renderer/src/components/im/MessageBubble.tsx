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
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImMessage } from '../../ipc/types';
import type { DispatchChild } from '../../stores/stream.store';
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

export function MessageBubble({ message, isSelf, senderName }: Props) {
  if (message.eventType === 'io.momo-studio.dispatch') {
    return <DispatchCard message={message} isSelf={isSelf} senderName={senderName} />;
  }
  if (message.eventType === 'io.momo-studio.task_reply') {
    return <TaskReplyCard message={message} isSelf={isSelf} senderName={senderName} />;
  }

  // 检测 agent 持久化字段：有 thinking 或 tool_calls 时渲染增强气泡
  const { thinking, toolCalls } = extractAgentMeta(message.content);
  const hasAgentMeta = thinking.length > 0 || toolCalls.length > 0;

  if (hasAgentMeta) {
    // v1.4 嵌套：分离 dispatch 委派与普通工具调用——前者渲染为 DispatchChip（历史模式，
    // 无实时 StreamState，仅展示完成/失败状态），后者保持 ToolCallChip 行为
    const regularToolCalls = toolCalls.filter((tc) => !isDispatchToolCall(tc));
    const dispatchToolCalls = toolCalls.filter(isDispatchToolCall);

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
        {/* v1.4 嵌套：dispatch chips 历史模式（不传 subStream——展开时无嵌套正文，PM body 已含关键信息） */}
        {dispatchToolCalls.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            {dispatchToolCalls.map((tc, i) => (
              <DispatchChip
                key={tc.subStreamSessionId ?? `hist-dispatch-${i}`}
                child={buildHistoryDispatchChild(tc, i)}
              />
            ))}
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
