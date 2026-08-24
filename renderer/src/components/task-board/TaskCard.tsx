// renderer/src/components/task-board/TaskCard.tsx
//
// 任务卡片（D 子系统 D7）：单条任务的列表项。
// 展示：优先级徽标 + #短ID · 标题 + 状态色 + 调度信息（计划/截止/指派）+ 进度（执行中显示已用时长 + 工具调用数）。
// 点击整行触发 onSelect，高亮选中态。
import type { TaskRow, TaskStatus } from '../../ipc/types';

/** 8 状态中文标签（TaskSidebarPanel 远端只读分区复用） */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: '草稿',
  pending: '待启动',
  assigned: '排队中',
  in_progress: '执行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** 状态对应前景色（TaskSidebarPanel 远端只读分区复用） */
export const STATUS_COLOR: Record<TaskStatus, string> = {
  draft: '#9ca3af',
  pending: '#fbbf24',
  assigned: '#3b82f6',
  in_progress: '#10b981',
  paused: '#a78bfa',
  completed: '#6b7280',
  failed: '#ef4444',
  cancelled: '#6b7280',
};

/** 优先级标签（0=无 / 1=低 / 5=中 / 10=高） */
const PRIORITY_LABEL: Record<number, string> = { 0: '', 1: '低', 5: '中', 10: '高' };

interface TaskCardProps {
  task: TaskRow;
  selected: boolean;
  onSelect: () => void;
}

export function TaskCard({ task, selected, onSelect }: TaskCardProps) {
  const color = STATUS_COLOR[task.status];
  const priorityLabel = PRIORITY_LABEL[task.priority];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 border-b border-border-subtle hover:bg-bg-tertiary ${
        selected ? 'bg-bg-tertiary' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-sm truncate">
          {priorityLabel && (
            <span style={{ color: '#fbbf24' }} className="mr-1">
              [{priorityLabel}]
            </span>
          )}
          #{task.id.slice(0, 6)} · {task.title}
        </span>
        <span style={{ color }} className="text-xs shrink-0">
          {STATUS_LABEL[task.status]}
        </span>
      </div>
      <div className="text-xs text-neutral-500 mt-1 flex gap-3">
        {task.scheduledAt && (
          <span>📅 {new Date(task.scheduledAt).toLocaleDateString()}</span>
        )}
        {task.deadlineAt && (
          <span>⏰ {new Date(task.deadlineAt).toLocaleDateString()}</span>
        )}
        {task.assigneeAgentId && (
          <span>🤖 {task.assigneeAgentId.slice(0, 12)}</span>
        )}
      </div>
      {task.status === 'in_progress' && task.startedAt && (
        <div className="text-xs text-neutral-500 mt-1">
          已用 {Math.round((Date.now() - task.startedAt) / 60000)} min · {task.toolCallsUsed}{' '}
          工具调用
        </div>
      )}
    </button>
  );
}
