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
//   - 消息体统一用 react-markdown 渲染（支持 GFM 表格、删除线等）
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import type { ImMessage } from '../../ipc/types';
import { useStreamStore } from '../../stores/stream.store';
import { cn } from '../../lib/cn';
import { DispatchCard } from './DispatchCard';
import { TaskReplyCard } from './TaskReplyCard';
import { MessageFrame } from './MessageFrame';
import { AgentStreamBubble } from './AgentStreamBubble';

/**
 * S2 链接拦截：markdown <a> 若走浏览器默认行为，恶意内容可能劫持渲染进程
 * （导航到外部页面后，preload 暴露的 window.api 暴露给不可信上下文）。
 * 这里统一 preventDefault + window.open → 主进程 setWindowOpenHandler 拒绝
 * 新窗口并转 shell.openExternal 走系统浏览器。
 */
function SafeAnchor(props: AnchorHTMLAttributes<HTMLAnchorElement>): JSX.Element {
  const { href, children, target: _target, rel: _rel, onClick: _onClick, ...rest } = props;
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    if (typeof href === 'string' && href.length > 0) {
      // noopener/noreferrer 双重保险；setWindowOpenHandler 仍会拒绝新窗口
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  };
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      {...rest}
    >
      {children as ReactNode}
    </a>
  );
}

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
      bubbleClassName={cn(isSelf ? 'bg-accent-500 text-inverse' : 'bg-surface-2 text-primary')}
    >
      {/* react-markdown 渲染消息体；p 元素默认有 margin，用样式覆盖；code/pre 交给 md-body */}
      <div className="md-body overflow-hidden min-w-0 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{ a: SafeAnchor } as Components}
        >
          {message.body}
        </ReactMarkdown>
      </div>
    </MessageFrame>
  );
}
