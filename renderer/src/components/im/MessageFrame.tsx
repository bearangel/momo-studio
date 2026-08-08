// renderer/src/components/im/MessageFrame.tsx
//
// 消息通用外壳：头像 + 名字 + 左右对齐气泡列。
// 三类消息（普通文本 / dispatch / task_reply）复用，保证视觉一致、归属统一。
// isSelf 决定左右对齐与自己消息隐藏名字（与原 MessageBubble 普通气泡行为一致）。
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { avatarEmoji, shortName } from './avatars';

interface Props {
  /** 发送者 Matrix userId（@xxx:server）；用于头像 emoji 与回退短名 */
  sender: string;
  isSelf: boolean;
  /** bot 配置名（优先于 shortName）；自己消息不显示名字 */
  senderName?: string;
  /** 内层气泡 className（边框/背景/文字色由调用方按消息类型决定） */
  bubbleClassName?: string;
  /** v1.5.7: 气泡最大宽度百分比（默认 70%，agent 流式气泡传 85% 加宽） */
  maxWidthPct?: number;
  children: ReactNode;
}

/**
 * 消息通用外壳：头像 + 名字 + 左右对齐气泡列。
 * 三类消息（普通文本 / dispatch / task_reply / 流式）复用，保证视觉一致、归属统一。
 * 只依赖 sender（Matrix userId），不绑定完整 ImMessage —— 流式气泡只有 botUserId 也能复用。
 * isSelf 决定左右对齐与自己消息隐藏名字。
 */
export function MessageFrame({ sender, isSelf, senderName, bubbleClassName, maxWidthPct = 70, children }: Props) {
  return (
    <div
      className={cn('flex gap-2 px-4 py-1', isSelf ? 'flex-row-reverse' : 'flex-row')}
      style={{ minWidth: 0, overflow: 'hidden' }}
    >
      <div className="w-8 h-8 shrink-0 rounded-full bg-bg-tertiary flex items-center justify-center text-base select-none">
        {avatarEmoji(sender)}
      </div>
      <div
        className={cn('flex flex-col gap-0.5', isSelf ? 'items-end' : 'items-start')}
        style={{ minWidth: 0, maxWidth: `${maxWidthPct}%`, overflow: 'hidden' }}
      >
        {!isSelf && (
          <span className="text-xs text-neutral-400 px-1">{senderName ?? shortName(sender)}</span>
        )}
        <div
          className={cn('rounded-lg px-3 py-2 text-sm break-words', bubbleClassName)}
          style={{ overflow: 'hidden', minWidth: 0, maxWidth: '100%' }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
