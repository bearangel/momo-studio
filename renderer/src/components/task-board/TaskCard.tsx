// renderer/src/components/task-board/TaskCard.tsx
//
// 任务卡片（D 子系统 D7）：优先级徽标 + #短ID · 标题 + 状态徽标 + 调度信息 + 进度。
// v2.1 P3：状态色/标签退役本地双 map，接线 taskStatusStyle（与 TaskChip 同源）；
// 📅⏰🤖 → Calendar/Clock/Bot lucide。
// Task 9：排队徽标（assigned 未放行）+ 循环标记/下次运行 + 团队/会话委派目标。
import { Bot, Calendar, Clock, MessagesSquare, Repeat, Users } from 'lucide-react';
import type { TaskRow } from '../../ipc/types';
import { taskStatusStyle } from '../../lib/task-status';
import { humanizeRecurrence } from '../../lib/recurrence';

/** 优先级标签（0=无 / 1=低 / 5=中 / 10=高） */
const PRIORITY_LABEL: Record<number, string> = { 0: '', 1: '低', 5: '中', 10: '高' };

interface TaskCardProps {
  task: TaskRow;
  selected: boolean;
  onSelect: () => void;
  /** 排队名次（TaskSidebarPanel 按放行序计算）；非 assigned 任务不传 */
  queueRank?: number;
}

export function TaskCard({ task, selected, onSelect, queueRank }: TaskCardProps) {
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
        <span className="inline-flex shrink-0 items-center gap-1.5">
          {/* 排队徽标：assigned 未放行（spec §8.2） */}
          {task.status === 'assigned' && queueRank !== undefined && (
            <span className="text-xs text-status-warning">排队 #{queueRank}</span>
          )}
          <span className={status.className}>{status.label}</span>
        </span>
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
        {/* 循环标记 + 下次运行（pending） */}
        {task.recurrenceRule && (
          <span className="inline-flex items-center gap-1">
            <Repeat size={11} strokeWidth={1.75} aria-hidden />
            {humanizeRecurrence(task.recurrenceRule)}
          </span>
        )}
        {task.status === 'pending' && task.recurrenceRule && task.scheduledAt && (
          <span>下次 {new Date(task.scheduledAt).toLocaleString('zh-CN')}</span>
        )}
        {/* 委派目标（agent=既有 Bot；团队/会话新图标） */}
        {task.targetTeamId && (
          <span className="inline-flex items-center gap-1">
            <Users size={11} strokeWidth={1.75} aria-hidden />
            {task.targetTeamId.slice(0, 8)}
          </span>
        )}
        {task.targetSessionId && (
          <span className="inline-flex items-center gap-1">
            <MessagesSquare size={11} strokeWidth={1.75} aria-hidden />
            {task.targetSessionId.slice(0, 8)}
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
