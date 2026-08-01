// renderer/src/components/im/TaskReplyCard.tsx
//
// task_reply 消息卡片：子 agent 向主 agent 回报任务状态。
// 字段取自 io.momo-studio.task_reply event content：
//   status (in_progress|completed|failed|needs_input), body, task_id, progress_pct?
// 对话化重构：走 MessageFrame（frame 头 = 子 agent 头像+名），补齐此前完全缺失的归属。
// 名字由 senderName prop 传入（MessageFrame 渲染），卡片本身不调 useBotNameMap。
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImMessage } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { MessageFrame } from './MessageFrame';

interface Props {
  message: ImMessage;
  isSelf: boolean;
  senderName?: string;
}

type ReplyStatus = 'in_progress' | 'completed' | 'failed' | 'needs_input';

interface TaskReplyFields {
  body: string;
  taskId: string;
  status: ReplyStatus;
  progressPct?: number;
}

const VALID_STATUSES: ReadonlySet<ReplyStatus> = new Set([
  'in_progress',
  'completed',
  'failed',
  'needs_input',
]);

const STATUS_STYLE: Record<
  ReplyStatus,
  { label: string; border: string; bg: string; text: string; bar: string }
> = {
  completed: {
    label: '已完成',
    border: 'border-status-success/40',
    bg: 'bg-status-success/10',
    text: 'text-status-success',
    bar: 'bg-status-success',
  },
  in_progress: {
    label: '进行中',
    border: 'border-status-info/40',
    bg: 'bg-status-info/10',
    text: 'text-status-info',
    bar: 'bg-status-info',
  },
  failed: {
    label: '失败',
    border: 'border-status-error/40',
    bg: 'bg-status-error/10',
    text: 'text-status-error',
    bar: 'bg-status-error',
  },
  needs_input: {
    label: '需补充输入',
    border: 'border-status-warning/40',
    bg: 'bg-status-warning/10',
    text: 'text-status-warning',
    bar: 'bg-status-warning',
  },
};

/** 从 message.content 安全解析 task_reply 字段；status 非法或缺字段时返回 null */
function readReply(content: Record<string, unknown> | undefined): TaskReplyFields | null {
  if (!content) return null;
  const taskId = content.task_id;
  const status = content.status;
  if (typeof taskId !== 'string') return null;
  if (typeof status !== 'string' || !VALID_STATUSES.has(status as ReplyStatus)) return null;
  const pct = content.progress_pct;
  return {
    body: typeof content.body === 'string' ? content.body : '',
    taskId,
    status: status as ReplyStatus,
    progressPct: typeof pct === 'number' ? pct : undefined,
  };
}

export function TaskReplyCard({ message, isSelf, senderName }: Props) {
  const fields = readReply(message.content);
  // 解析失败时回退为普通气泡渲染（走 frame 保留归属），保证不丢消息
  if (!fields) {
    const rawContentBody = message.content.body;
    return (
      <MessageFrame
        message={message}
        isSelf={isSelf}
        senderName={senderName}
        bubbleClassName="bg-bg-tertiary text-neutral-300"
      >
        {typeof rawContentBody === 'string' ? rawContentBody : message.body}
      </MessageFrame>
    );
  }

  const style = STATUS_STYLE[fields.status];
  const pct =
    fields.progressPct !== undefined ? Math.max(0, Math.min(100, fields.progressPct)) : null;

  return (
    <MessageFrame
      message={message}
      isSelf={isSelf}
      senderName={senderName}
      bubbleClassName={cn('border', style.border, style.bg)}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 font-medium', style.text)}>
          {style.label}
        </span>
        <span className="text-neutral-500">#{fields.taskId.slice(0, 8)}</span>
      </div>

      <div className="mt-1.5 text-sm text-neutral-100 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:bg-black/30">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{fields.body}</ReactMarkdown>
      </div>

      {pct !== null && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/30">
          <div className={cn('h-full rounded-full', style.bar)} style={{ width: `${pct}%` }} />
        </div>
      )}
    </MessageFrame>
  );
}