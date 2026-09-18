// renderer/src/components/im/TodoSection.tsx
//
// 待办清单折叠卡片（v1 语义恢复，v3 回归气泡内联）：流式默认展开、完成自动
// 折叠、手动开合；条目渲染单源 TodoList。spec §3.3。
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ListTodo } from 'lucide-react';
import { TodoList } from './TodoList';
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
          {expanded ? (
            <ChevronDown size={12} strokeWidth={1.75} aria-hidden />
          ) : (
            <ChevronRight size={12} strokeWidth={1.75} aria-hidden />
          )}
        </span>
      </button>
      {expanded && <TodoList todos={todos} />}
    </div>
  );
}
