// renderer/src/components/im/DispatchCard.tsx
//
// dispatch 消息卡片（紫色）：主 agent 向子 agent 调度任务。
// 字段取自 io.momo-studio.dispatch event content：
//   dispatch_from → dispatch_to, body, task_id, deadline_ms?
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImMessage } from '../../ipc/types';
import { avatarEmoji } from './avatars';
import { useBotNameMap, resolveBotName } from '../../lib/useBotNames';

interface Props {
  message: ImMessage;
}

interface DispatchFields {
  body: string;
  taskId: string;
  from: string;
  to: string;
  deadlineMs?: number;
}

/** 从 message.content 安全解析 dispatch 字段；缺关键字段时返回 null（调用方回退普通渲染） */
function readDispatch(content: Record<string, unknown> | undefined): DispatchFields | null {
  if (!content) return null;
  const taskId = content.task_id;
  const from = content.dispatch_from;
  const to = content.dispatch_to;
  if (typeof taskId !== 'string') return null;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const deadline = content.deadline_ms;
  return {
    body: typeof content.body === 'string' ? content.body : '',
    taskId,
    from,
    to,
    deadlineMs: typeof deadline === 'number' ? deadline : undefined,
  };
}

export function DispatchCard({ message }: Props) {
  const botNameMap = useBotNameMap();
  const fields = readDispatch(message.content);
  // 解析失败时回退为普通消息渲染，保证不丢消息
  if (!fields) {
    return (
      <div className="mx-4 my-1 rounded-lg bg-bg-tertiary px-3 py-2 text-sm text-neutral-300">
        {message.body}
      </div>
    );
  }

  return (
    <div className="mx-4 my-2 rounded-lg border border-accent-purple/40 bg-accent-purple/10 px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium text-accent-purple">任务调度</span>
        <span className="text-neutral-500">#{fields.taskId.slice(0, 8)}</span>
      </div>

      <div className="mt-1.5 flex items-center gap-2 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden>{avatarEmoji(fields.from)}</span>
          <span className="text-neutral-200">{resolveBotName(fields.from, botNameMap)}</span>
        </span>
        <span className="text-neutral-500">→</span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden>{avatarEmoji(fields.to)}</span>
          <span className="text-neutral-200">{resolveBotName(fields.to, botNameMap)}</span>
        </span>
      </div>

      <div className="mt-1.5 text-sm text-neutral-100 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:bg-black/30">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{fields.body}</ReactMarkdown>
      </div>

      {fields.deadlineMs !== undefined && (
        <div className="mt-1.5 text-xs text-neutral-500">
          截止：{new Date(fields.deadlineMs).toLocaleString()}
        </div>
      )}
    </div>
  );
}
