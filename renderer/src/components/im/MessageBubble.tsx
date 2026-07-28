// renderer/src/components/im/MessageBubble.tsx
//
// 单条消息气泡。自己的消息右对齐蓝色，其他人左对齐灰色。
// 消息体用 react-markdown 渲染（支持 GFM 表格、删除线等）。
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImMessage } from '../../ipc/types';
import { cn } from '../../lib/cn';

interface Props {
  message: ImMessage;
  isSelf: boolean;
}

/** 从 Matrix userId（如 @alice:localhost）提取短名（alice） */
function shortName(userId: string): string {
  const match = /^@([^:]+):/.exec(userId);
  return match?.[1] ?? userId;
}

const AVATAR_EMOJIS = ['🦊', '🐱', '🐼', '🐨', '🦁', '🐯', '🐸', '🐵', '🦉', '🐧'];

/** 基于用户 ID 稳定哈希生成 emoji 头像 */
function avatarEmoji(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return AVATAR_EMOJIS[Math.abs(hash) % AVATAR_EMOJIS.length]!;
}

export function MessageBubble({ message, isSelf }: Props) {
  return (
    <div className={cn('flex gap-2 px-4 py-1', isSelf ? 'flex-row-reverse' : 'flex-row')}>
      <div className="w-8 h-8 shrink-0 rounded-full bg-bg-tertiary flex items-center justify-center text-base select-none">
        {avatarEmoji(message.sender)}
      </div>
      <div className={cn('max-w-[70%] flex flex-col gap-0.5', isSelf ? 'items-end' : 'items-start')}>
        {!isSelf && (
          <span className="text-xs text-neutral-400 px-1">{shortName(message.sender)}</span>
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
