// renderer/src/components/im/TodoSection.tsx
//
// 任务面板：TodoItem[] 可折叠列表（含进度）。流式默认展开、结束自动折叠。
// v2.1：inline hex/字形退役（📋→ListTodo；✓▶○→lucide；▼▶→Chevron）。
import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Circle, ListTodo, Play } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { TodoItem } from '../../ipc/types';

interface Props {
  todos: TodoItem[];
  isStreaming: boolean;
}

export function TodoSection({ todos, isStreaming }: Props) {
  const [expanded, setExpanded] = useState(isStreaming);

  useEffect(() => {
    if (!isStreaming) setExpanded(false);
  }, [isStreaming]);

  if (todos.length === 0) return null;

  const doneCount = todos.filter((t) => t.status === 'completed').length;
  const totalCount = todos.length;
  const progressPct = Math.round((doneCount / totalCount) * 100);

  return (
    <div className="my-2 overflow-hidden rounded border border-subtle text-[13px]">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between bg-surface-2 px-3 py-1.5 cursor-pointer"
      >
        <span className="inline-flex items-center gap-1.5 font-medium text-primary">
          <ListTodo size={13} strokeWidth={1.75} aria-hidden />
          任务
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-tertiary">
          {doneCount}/{totalCount}（{progressPct}%）
          {expanded ? <ChevronDown size={12} strokeWidth={1.75} aria-hidden /> : <ChevronRight size={12} strokeWidth={1.75} aria-hidden />}
        </span>
      </button>
      {expanded && (
        <ul className="m-0 list-none px-3 py-2">
          {todos.map((t, i) => {
            const Icon = t.status === 'completed' ? Check : t.status === 'in_progress' ? Play : Circle;
            return (
              <li
                key={t.id}
                className={cn(
                  'flex gap-2',
                  t.status === 'completed' ? 'line-through opacity-60' : '',
                  t.status === 'in_progress' ? 'font-medium text-accent-600 dark:text-accent-300' : 'text-secondary',
                  i === todos.length - 1 ? '' : 'mb-1',
                )}
              >
                <Icon size={12} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" />
                <span>
                  {i + 1}. {t.subject}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
