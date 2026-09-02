// renderer/src/components/im/TaskChip.tsx
//
// #T-XXX 任务 chip：任务编号 + 短标题，点击跳转。颜色走 task-status 统一映射
// （v2.1：原 inline hex STATUS_COLOR 调色板退役，与 TaskCard/DispatchChip 同源）。
// 标题截断只走 CSS truncate（max-w 140px），title 属性提供全文（v2.1 P3：去 JS 双重截断）。
import { Hash } from 'lucide-react';
import { cn } from '../../lib/cn';
import { taskStatusStyle } from '../../lib/task-status';
import type { TaskRow } from '../../ipc/types';

interface TaskChipProps {
  task: Pick<TaskRow, 'id' | 'title' | 'status'>;
  onClick?: (taskId: string) => void;
}

export function TaskChip({ task, onClick }: TaskChipProps) {
  const status = taskStatusStyle(task.status);
  return (
    <button
      type="button"
      onClick={() => onClick?.(task.id)}
      title={task.title}
      className={cn('inline-flex items-center gap-1 text-xs', status.className)}
    >
      <Hash size={11} strokeWidth={2} aria-hidden />
      <span className="font-mono">{task.id}</span>
      <span className="max-w-[140px] truncate">{task.title}</span>
    </button>
  );
}
