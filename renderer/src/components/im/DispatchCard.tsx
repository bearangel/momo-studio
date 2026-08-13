// renderer/src/components/im/DispatchCard.tsx
//
// dispatch 消息卡片：主 agent 向子 agent 调度任务。
// 字段取自 io.momo-studio.dispatch event content：
//   dispatch_from → dispatch_to, body, task_id, deadline_ms?
// 对话化重构：走 MessageFrame（frame 头 = 主 agent 头像+名 = dispatch_from），
// 卡片内只紧凑显示 target（dispatch_to），去除冗余 from。
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImMessage } from '../../ipc/types';
import { avatarEmoji } from './avatars';
import { useBotNameMap, resolveBotName } from '../../lib/useBotNames';
import { MessageFrame } from './MessageFrame';

interface Props {
  message: ImMessage;
  isSelf: boolean;
  senderName?: string;
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

export function DispatchCard({ message, isSelf, senderName }: Props) {
  const botNameMap = useBotNameMap();
  // v2.0 A 子系统过渡：ImMessage 已删除 content 字段，dispatch 富字段（dispatch_to /
  // dispatch_from / task_id / deadline_ms）改走 message_events 表。A9 改造时重写。
  // @ts-expect-error A9 待移除：ImMessage.content 已删除
  const fields = readDispatch(message.content);
  // 解析失败时回退为普通气泡渲染（走 frame 保留归属），保证不丢消息
  if (!fields) {
    // @ts-expect-error A9 待移除：ImMessage.content 已删除
    const rawContentBody = message.content.body;
    return (
      <MessageFrame
        sender={message.sender}
        isSelf={isSelf}
        senderName={senderName}
        bubbleClassName="bg-bg-tertiary text-neutral-300"
      >
        {typeof rawContentBody === 'string' ? rawContentBody : message.body}
      </MessageFrame>
    );
  }

  return (
    <MessageFrame
      sender={message.sender}
      isSelf={isSelf}
      senderName={senderName}
      bubbleClassName="border border-accent-purple/40 bg-accent-purple/10"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center rounded bg-accent-purple/20 px-1.5 py-0.5 font-medium text-accent-purple">
          调度
        </span>
        <span className="text-neutral-500">#{fields.taskId.slice(0, 8)}</span>
        <span className="text-neutral-500">→</span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden>{avatarEmoji(fields.to)}</span>
          <span className="text-neutral-200">{resolveBotName(fields.to, botNameMap)}</span>
        </span>
      </div>

      <div className="mt-1.5 text-sm text-neutral-100 overflow-hidden min-w-0 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:bg-black/30">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{fields.body}</ReactMarkdown>
      </div>

      {fields.deadlineMs !== undefined && (
        <div className="mt-1.5 text-xs text-neutral-500">
          截止：{new Date(fields.deadlineMs).toLocaleString()}
        </div>
      )}
    </MessageFrame>
  );
}
