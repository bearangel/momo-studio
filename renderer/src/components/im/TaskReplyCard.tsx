// renderer/src/components/im/TaskReplyCard.tsx
//
// task_reply 消息卡片：子 agent 向主 agent 回报任务状态。
//
// v2.0 A 子系统：ImMessage 已删除 content 字段。task_reply 的富字段（status /
// task_id / progress_pct）在 A 子系统过渡期不再随 Matrix event content 传输——
// 本卡片降级为仅显示 body + taskId（来自 ImMessage 字段）。
// task_reply 的完整富信息（状态徽标 / 进度条）改由 message_events 表 +
// aggregateEvents 在父 agent 气泡的 DispatchChip 内渲染（见 AgentStreamBubble）。
// 本卡片仅作为防御性兜底：正常流程下 task_reply 消息被 MessageList 过滤、不独立渲染。
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImMessage } from '../../ipc/types';
import { MessageFrame } from './MessageFrame';

interface Props {
  message: ImMessage;
  isSelf: boolean;
  senderName?: string;
}

export function TaskReplyCard({ message, isSelf, senderName }: Props) {
  return (
    <MessageFrame
      sender={message.sender}
      isSelf={isSelf}
      senderName={senderName}
      bubbleClassName="bg-surface-2 text-primary border border-subtle"
      timestamp={message.createdAt}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-flex items-center rounded bg-status-violet/20 px-1.5 py-0.5 font-medium text-status-violet">
          任务回执
        </span>
        {message.taskId && (
          <span className="text-tertiary">#{message.taskId.slice(0, 8)}</span>
        )}
      </div>

      {message.body && (
        <div className="md-body mt-1.5 text-sm text-primary overflow-hidden min-w-0 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown>
        </div>
      )}
    </MessageFrame>
  );
}
