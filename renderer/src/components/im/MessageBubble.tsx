// renderer/src/components/im/MessageBubble.tsx
//
// 单条消息渲染入口。根据 eventType 分发：
//   - io.momo-studio.dispatch   → DispatchCard（紫色，走 MessageFrame）
//   - io.momo-studio.task_reply → TaskReplyCard（状态色，走 MessageFrame）
//   - m.room.message（含活跃 stream） → AgentStreamBubble（流式聚合渲染）
//   - 其余 → 普通气泡（走 MessageFrame，自己蓝/他人灰）
//
// v2.0 A 子系统重写：
//   - 按 message.id 查 stream.store.get()，streaming 时渲染 AgentStreamBubble
//   - 删除旧版从 message.content 提取 io.momo-studio.* 富字段的逻辑
//     （thinking/tool_calls/dispatches 改由 message_events 表 + aggregateEvents 重建，
//      在 stream.store 内聚合，本组件只判断 streaming/静态两种状态）
//   - 消息体统一用 react-markdown 渲染（支持 GFM 表格、删除线等）
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImMessage } from '../../ipc/types';
import { useStreamStore } from '../../stores/stream.store';
import { cn } from '../../lib/cn';
import { DispatchCard } from './DispatchCard';
import { TaskReplyCard } from './TaskReplyCard';
import { MessageFrame } from './MessageFrame';
import { AgentStreamBubble } from './AgentStreamBubble';

interface Props {
  message: ImMessage;
  isSelf: boolean;
  /** bot 的配置名称（如有），优先于 shortName 展示 */
  senderName?: string;
  /** 同房间的全部消息（SegmentStack / DispatchChip 跨房间搜索用） */
  allMessages?: ImMessage[];
}

export function MessageBubble({ message, isSelf, senderName }: Props) {
  // A 子系统：按 message.id 查 stream。streaming 时用 AgentStreamBubble 渲染富信息，
  // 否则渲染静态消息（基于 message.body）。
  const stream = useStreamStore((s) => s.streams.get(message.id));

  if (message.eventType === 'io.momo-studio.dispatch') {
    return <DispatchCard message={message} isSelf={isSelf} senderName={senderName} />;
  }
  if (message.eventType === 'io.momo-studio.task_reply') {
    return <TaskReplyCard message={message} isSelf={isSelf} senderName={senderName} />;
  }

  if (stream && stream.status === 'streaming') {
    return <AgentStreamBubble stream={stream} message={message} senderName={senderName} />;
  }

  // 静态气泡（已完成或无 stream）
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
