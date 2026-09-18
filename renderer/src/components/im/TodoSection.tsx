// renderer/src/components/im/TodoSection.tsx
//
// 待办清单纯列表渲染（v2 交互改版）：
//   v1 的 header 折叠按钮与 isStreaming 自动展开语义已移除——摘要行与展开
//   控制归 SessionTodoBar（spec 2026-09-18-session-todo-bar-ux-refine-design.md §4）。
//   本组件只负责：条目三态图标（Check/Play/Circle）、完成态 line-through、序号。
import { Check, Circle, Play } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { TodoItem } from '../../ipc/types';

interface Props {
  todos: TodoItem[];
}

export function TodoSection({ todos }: Props) {
  if (todos.length === 0) return null;

  return (
    <ul className="m-0 list-none py-2">
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
