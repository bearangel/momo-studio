// renderer/src/components/im/MessageBubble.tsx
//
// 单条消息渲染入口。根据 eventType 分发：
//   - io.momo-studio.dispatch   → DispatchCard（紫色，走 MessageFrame）
//   - io.momo-studio.task_reply → TaskReplyCard（状态色，走 MessageFrame）
//   - m.room.message（含活跃 stream 或已完成带富信息） → AgentStreamBubble
//   - 其余 → 普通气泡（走 MessageFrame，自己蓝/他人灰）
//
// v2.0 A 子系统重写：
//   - 按 message.id 查 stream.store.get()，streaming 时渲染 AgentStreamBubble
//   - 已完成（done/failed/aborted）但带富信息（thinking/工具调用/dispatches）时
//     也走 AgentStreamBubble——从 message_events 聚合重建，重启后一致
//
// v2.1 渲染收敛：
//   - 消息体经 MarkdownBody 统一渲染（v2.1 收敛），SafeAnchor/CodeBlock/表格滚动容器全调用点一致
//
// v2.1 会话渲染优化：
//   - 删除本地 SafeAnchor 副本，正文经 MarkdownBody 统一入口（S2 链接拦截一致）
//   - 静态气泡补时间戳；agent 回复（非自己）hover 气泡显示复制按钮
import type { ImMessage } from '../../ipc/types';
import { useStreamStore } from '../../stores/stream.store';
import { cn } from '../../lib/cn';
import { DispatchCard } from './DispatchCard';
import { TaskReplyCard } from './TaskReplyCard';
import { MessageFrame } from './MessageFrame';
import { AgentStreamBubble } from './AgentStreamBubble';
import { MarkdownBody } from './MarkdownBody';
import { CopyButton } from '../ui/CopyButton';

interface Props {
  message: ImMessage;
  isSelf: boolean;
  /** bot 的配置名称（如有），优先于 shortName 展示 */
  senderName?: string;
}

export function MessageBubble({ message, isSelf, senderName }: Props) {
  // A 子系统：按 message.id 查 stream。streaming 或已完成带富信息时用 AgentStreamBubble
  // 渲染（thinking/工具调用/dispatches 从 message_events 聚合），否则渲染静态消息。
  const stream = useStreamStore((s) => s.streams.get(message.id));

  if (message.eventType === 'io.momo-studio.dispatch') {
    return <DispatchCard message={message} isSelf={isSelf} senderName={senderName} />;
  }
  if (message.eventType === 'io.momo-studio.task_reply') {
    return <TaskReplyCard message={message} isSelf={isSelf} senderName={senderName} />;
  }

  // 流式中 OR 已完成但带富信息 OR 失败带错误文本：用 AgentStreamBubble 渲染——
  // 否则错误（含失败的具体原因）会被静态气泡吞掉不可见（2.0.0 主机验收 P0-3）。
  if (
    stream &&
    (stream.status === 'streaming' ||
      stream.status === 'failed' ||
      stream.error !== undefined ||
      stream.thinking.length > 0 ||
      stream.toolCalls.length > 0 ||
      stream.dispatches.length > 0)
  ) {
    return <AgentStreamBubble stream={stream} message={message} senderName={senderName} />;
  }

  // 静态气泡（普通文本消息，或已完成但无富信息的 agent 回复）
  return (
    <MessageFrame
      sender={message.sender}
      isSelf={isSelf}
      senderName={senderName}
      bubbleClassName={cn(
        'relative group',
        isSelf ? 'bg-accent-500 text-inverse' : 'bg-surface-2 text-primary',
      )}
      timestamp={message.createdAt}
    >
      <MarkdownBody>{message.body}</MarkdownBody>
      {!isSelf && (
        <CopyButton
          text={message.body}
          className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        />
      )}
    </MessageFrame>
  );
}
