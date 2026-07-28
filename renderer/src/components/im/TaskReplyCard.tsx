// renderer/src/components/im/TaskReplyCard.tsx
//
// task_reply 消息卡片：子 agent 向主 agent 回报任务状态。
// 字段取自 io.momo-studio.task_reply event content：
//   status (in_progress|completed|failed|needs_input), body, task_id, progress_pct?
// 卡片配色按 status 映射到语义状态 token（绿/蓝/红/琥珀）。
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImMessage } from '../../ipc/types';
import { cn } from '../../lib/cn';

interface Props {
  message: ImMessage;
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

export function TaskReplyCard({ message }: Props) {
  const fields = readReply(message.content);
  // 解析失败时回退为普通消息渲染，保证不丢消息
  if (!fields) {
    return (
      <div className="mx-4 my-1 rounded-lg bg-bg-tertiary px-3 py-2 text-sm text-neutral-300">
        {message.body}
      </div>
    );
  }

  const style = STATUS_STYLE[fields.status];
  const pct =
    fields.progressPct !== undefined ? Math.max(0, Math.min(100, fields.progressPct)) : null;

  return (
    <div className={cn('mx-4 my-2 rounded-lg border px-3 py-2', style.border, style.bg)}>
      <div className="flex items-center gap-2 text-xs">
        <span className={cn('font-medium', style.text)}>{style.label}</span>
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
    </div>
  );
}
