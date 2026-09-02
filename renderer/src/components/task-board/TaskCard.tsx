// renderer/src/components/task-board/TaskCard.tsx
//
// 任务卡片（D 子系统 D7）：优先级徽标 + #短ID · 标题 + 状态徽标 + 调度信息 + 进度。
// v2.1 P3：状态色/标签退役本地双 map，接线 taskStatusStyle（与 TaskChip 同源）；
// 📅⏰🤖 → Calendar/Clock/Bot lucide。
import { Bot, Calendar, Clock } from 'lucide-react';
import type { TaskRow } from '../../ipc/types';
import { taskStatusStyle } from '../../lib/task-status';

/** 优先级标签（0=无 / 1=低 / 5=中 / 10=高） */
const PRIORITY_LABEL: Record<number, string> = { 0: '', 1: '低', 5: '中', 10: '高' };

interface TaskCardProps {
  task: TaskRow;
  selected: boolean;
  onSelect: () => void;
}

export function TaskCard({ task, selected, onSelect }: TaskCardProps) {
  const status = taskStatusStyle(task.status);
  const priorityLabel = PRIORITY_LABEL[task.priority];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full cursor-pointer border-b border-subtle px-3 py-2 text-left transition-colors hover:bg-surface-3 ${
        selected ? 'bg-surface-active' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-primary">
          {priorityLabel && <span className="mr-1 text-status-warning">[{priorityLabel}]</span>}
          #{task.id.slice(0, 6)} · {task.title}
        </span>
        <span className={status.className}>{status.label}</span>
      </div>
      <div className="mt-1 flex gap-3 text-xs text-tertiary">
        {task.scheduledAt && (
          <span className="inline-flex items-center gap-1">
            <Calendar size={11} strokeWidth={1.75} aria-hidden />
            {new Date(task.scheduledAt).toLocaleDateString()}
          </span>
        )}
        {task.deadlineAt && (
          <span className="inline-flex items-center gap-1">
            <Clock size={11} strokeWidth={1.75} aria-hidden />
            {new Date(task.deadlineAt).toLocaleDateString()}
          </span>
        )}
        {task.assigneeAgentId && (
          <span className="inline-flex items-center gap-1">
            <Bot size={11} strokeWidth={1.75} aria-hidden />
            {task.assigneeAgentId.slice(0, 12)}
          </span>
        )}
      </div>
      {task.status === 'in_progress' && task.startedAt && (
        <div className="mt-1 text-xs text-tertiary">
          已用 {Math.round((Date.now() - task.startedAt) / 60000)} min · {task.toolCallsUsed}{' '}
          工具调用
        </div>
      )}
    </button>
  );
}
