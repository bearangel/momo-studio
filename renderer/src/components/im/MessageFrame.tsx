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
  /**
   * v1.5.7: 气泡最大宽度百分比（默认 70%，agent 流式气泡传 90% 加宽）。
   * v1.5.8: 仅当 fillWidth=false 时是上限（内容短时气泡收缩）。
   */
  maxWidthPct?: number;
  /**
   * v1.5.8: true 时气泡列强制占 maxWidthPct% 宽度（不再随内容收缩）。
   * agent 气泡内容丰富（thinking + 多 tool_call + markdown），用 maxWidth 模式
   * 会被内容 natural width 限制导致视觉上比期望窄。fillWidth=true 让气泡列固定宽度，
   * 内层气泡撑满，视觉一致。
   */
  fillWidth?: boolean;
  children: ReactNode;
}

/**
 * 消息通用外壳：头像 + 名字 + 左右对齐气泡列。
 * 三类消息（普通文本 / dispatch / task_reply / 流式）复用，保证视觉一致、归属统一。
 * 只依赖 sender（Matrix userId），不绑定完整 ImMessage —— 流式气泡只有 botUserId 也能复用。
 * isSelf 决定左右对齐与自己消息隐藏名字。
 */
export function MessageFrame({
  sender,
  isSelf,
  senderName,
  bubbleClassName,
  maxWidthPct = 70,
  fillWidth = false,
  children,
}: Props) {
  return (
    <div
      className={cn('flex gap-2 px-4 py-1', isSelf ? 'flex-row-reverse' : 'flex-row')}
      style={{ minWidth: 0, overflow: 'hidden' }}
    >
      <div className="w-8 h-8 shrink-0 rounded-full bg-surface-2 flex items-center justify-center text-base select-none">
        {avatarEmoji(sender)}
      </div>
      <div
        className={cn('flex flex-col gap-0.5', isSelf ? 'items-end' : 'items-start')}
        style={{
          minWidth: 0,
          // v1.5.8: fillWidth=true 强制占满（agent 气泡），否则为上限（普通消息随内容收缩）
          [fillWidth ? 'width' : 'maxWidth']: `${maxWidthPct}%`,
          overflow: 'hidden',
        }}
      >
        {!isSelf && (
          <span className="text-xs text-secondary px-1">{senderName ?? shortName(sender)}</span>
        )}
        <div
          className={cn('rounded-lg px-3 py-2 text-sm break-words', bubbleClassName)}
          style={{ overflow: 'hidden', minWidth: 0, width: fillWidth ? '100%' : undefined, maxWidth: '100%' }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
