// renderer/src/components/im/TodoList.tsx
//
// 待办清单纯列表渲染（条目单源）：三态图标（Check/Play/Circle）、完成态
// line-through、序号。消费方：TodoSection（气泡内联，v1 折叠语义）与
// TaskProgressButton（头部浮层）。spec 2026-09-18-session-todo-header-button-design.md §4。
import { Check, Circle, Play } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { TodoItem } from '../../ipc/types';

interface Props {
  todos: TodoItem[];
}

export function TodoList({ todos }: Props) {
  if (todos.length === 0) return null;

  return (
    <ul className="m-0 list-none px-2 py-2">
      {todos.map((t, i) => {
        const Icon = t.status === 'completed' ? Check : t.status === 'in_progress' ? Play : Circle;
        return (
          <li
            key={t.id}
            className={cn(
              'flex gap-2',
              t.status === 'completed' ? 'line-through opacity-60' : '',
              t.status === 'in_progress'
                ? 'font-medium text-accent-600 dark:text-accent-300'
                : 'text-secondary',
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
  );
}
