// renderer/src/components/im/DispatchCard.tsx
//
// dispatch 消息卡片：主 agent 向子 agent 调度任务。
//
// v2.0 A 子系统：ImMessage 已删除 content 字段。dispatch 的富字段（dispatch_to /
// dispatch_from / task_id / deadline_ms）在 A 子系统过渡期不再随 Matrix event content
// 传输——本卡片降级为仅显示 body + taskId（来自 ImMessage 字段）。
// dispatch 的完整富信息（目标 agent / 截止时间）改由 message_events 表 +
// aggregateEvents 在父 agent 气泡的 DispatchChip 内渲染（见 AgentStreamBubble）。
// 本卡片仅作为防御性兜底：正常流程下 dispatch 消息被 MessageList 过滤、不独立渲染。
import type { ImMessage } from '../../ipc/types';
import { MessageFrame } from './MessageFrame';
import { MarkdownBody } from './MarkdownBody';

interface Props {
  message: ImMessage;
  isSelf: boolean;
  senderName?: string;
}

export function DispatchCard({ message, isSelf, senderName }: Props) {
  return (
    <MessageFrame
      sender={message.sender}
      isSelf={isSelf}
      senderName={senderName}
      bubbleClassName="border border-status-violet/40 bg-status-violet-tint"
      timestamp={message.createdAt}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center rounded bg-status-violet/20 px-1.5 py-0.5 font-medium text-status-violet">
          调度
        </span>
        {message.taskId && (
          <span className="text-tertiary">#{message.taskId.slice(0, 8)}</span>
        )}
      </div>

      {message.body && (
        <div className="mt-1.5 text-sm text-primary overflow-hidden min-w-0">
          <MarkdownBody>{message.body}</MarkdownBody>
        </div>
      )}
    </MessageFrame>
  );
}
