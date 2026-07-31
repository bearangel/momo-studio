// renderer/src/components/im/MessageBubble.tsx
//
// 单条消息渲染入口。根据 eventType 分发：
//   - io.momo-studio.dispatch   → 紫色 DispatchCard
//   - io.momo-studio.task_reply → 状态色 TaskReplyCard
//   - 其余（m.room.message 等）   → 普通气泡（自己右对齐蓝色，他人左对齐灰色）
// 消息体统一用 react-markdown 渲染（支持 GFM 表格、删除线等）。
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImMessage } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { avatarEmoji, shortName } from './avatars';
import { DispatchCard } from './DispatchCard';
import { TaskReplyCard } from './TaskReplyCard';

interface Props {
  message: ImMessage;
  isSelf: boolean;
  /** bot 的配置名称（如有），优先于 shortName 展示 */
  senderName?: string;
}

export function MessageBubble({ message, isSelf, senderName }: Props) {
  if (message.eventType === 'io.momo-studio.dispatch') {
    return <DispatchCard message={message} />;
  }
  if (message.eventType === 'io.momo-studio.task_reply') {
    return <TaskReplyCard message={message} />;
  }

  return (
    <div className={cn('flex gap-2 px-4 py-1', isSelf ? 'flex-row-reverse' : 'flex-row')}>
      <div className="w-8 h-8 shrink-0 rounded-full bg-bg-tertiary flex items-center justify-center text-base select-none">
        {avatarEmoji(message.sender)}
      </div>
      <div className={cn('max-w-[70%] flex flex-col gap-0.5', isSelf ? 'items-end' : 'items-start')}>
        {!isSelf && (
          <span className="text-xs text-neutral-400 px-1">{senderName ?? shortName(message.sender)}</span>
        )}
        <div
          className={cn(
            'rounded-lg px-3 py-2 text-sm break-words',
            isSelf ? 'bg-accent-blue text-white' : 'bg-bg-tertiary text-neutral-100',
          )}
        >
          {/* react-markdown 渲染消息体；p 元素默认有 margin，用 prose-none 风格覆盖 */}
          <div className="[&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:bg-black/30">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}
