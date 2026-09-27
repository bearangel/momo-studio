// renderer/src/components/task-board/BoardCard.tsx
//
// 看板卡片（看板重构 Task 11，spec §5.2）——从 TaskCard 派生：
//   - 独立圆角卡：bg-canvas + border-subtle，hover 边框加深（border-strong）
//   - 标题行：[优先级] 前缀 + #短ID · 标题 + 状态徽标（task-status.ts 单源，
//     中间态 session_queued→「排队中」/ paused→「已暂停」由徽标天然表达，不占列）
//   - 元信息行复用 TaskCard 内容：日程/截止/指派 agent/循环/委派目标
//   - 平铺模式补显 groupChip（色点+组名，spec §5.2）；泳道模式（Task 12）组即道省略
// 静态渲染阶段（本任务）：纯点击选中，拖拽接线在 Task 12（@dnd-kit sortable 包装）。
import { Bot, Calendar, Clock, MessagesSquare, Repeat, Users } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { TaskRow } from '../../ipc/types';
import { taskStatusStyle } from '../../lib/task-status';
import { groupColorStyle } from '../../lib/board';
import { humanizeRecurrence } from '../../lib/recurrence';
import { useTaskEntityNames } from './useTaskEntityNames';

/** 优先级标签（0=无 / 1=低 / 5=中 / 10=高）——与 TaskCard 同源词表 */
const PRIORITY_LABEL: Record<number, string> = { 0: '', 1: '低', 5: '中', 10: '高' };

/** 平铺模式组 chip 数据（组名 + 语义色名；由父层从 group.store 解析传入） */
export interface BoardGroupChip {
  name: string;
  color: string | null;
}

interface BoardCardProps {
  task: TaskRow;
  selected: boolean;
  onClick: () => void;
  /** 平铺模式所属组 chip；null / 不传 = 不渲染（泳道模式） */
  groupChip?: BoardGroupChip | null;
}

export function BoardCard({ task, selected, onClick, groupChip }: BoardCardProps) {
  const status = taskStatusStyle(task.status);
  const priorityLabel = PRIORITY_LABEL[task.priority];
  const names = useTaskEntityNames(task.workspaceId);
  // 组色点：groupColorStyle 返回 token 形式的 CSS 变量串（设计系统唯一豁免的
  // inline 色），未知/无色 → 中性 tertiary
  const dotColor = groupChip ? groupColorStyle(groupChip.color) : null;
  const dotStyle: CSSProperties | undefined = dotColor
    ? { backgroundColor: dotColor }
    : { backgroundColor: 'rgb(var(--text-tertiary))' };

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`w-full cursor-pointer rounded-md border bg-canvas px-2.5 py-2 text-left transition-colors hover:border-strong hover:bg-surface-1 ${
        selected ? 'border-focus' : 'border-subtle'
      }`}
    >
      <div className="flex items-start justify-between gap-1.5">
        <span className="min-w-0 flex-1 text-xs font-medium leading-relaxed text-primary">
          {priorityLabel && <span className="mr-0.5 text-status-warning">[{priorityLabel}]</span>}
          #{task.id.slice(0, 6)} · {task.title}
        </span>
        <span className={status.className}>{status.label}</span>
      </div>
      {(groupChip ||
        task.scheduledAt ||
        task.deadlineAt ||
        task.assigneeAgentId ||
        task.recurrenceRule ||
        task.targetTeamId ||
        task.targetSessionId) && (
        <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-tertiary">
          {groupChip && (
            <span className="inline-flex items-center gap-1 rounded-sm bg-surface-2 px-1.5 py-px">
              <i aria-hidden className="inline-block h-1.5 w-1.5 rounded-[2px]" style={dotStyle} />
              {groupChip.name}
            </span>
          )}
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
              {names.agentName(task.assigneeAgentId)}
            </span>
          )}
          {task.recurrenceRule && (
            <span className="inline-flex items-center gap-1">
              <Repeat size={11} strokeWidth={1.75} aria-hidden />
              {humanizeRecurrence(task.recurrenceRule)}
            </span>
          )}
          {task.targetTeamId && (
            <span className="inline-flex items-center gap-1">
              <Users size={11} strokeWidth={1.75} aria-hidden />
              {names.teamName(task.targetTeamId)}
            </span>
          )}
          {task.targetSessionId && (
            <span className="inline-flex items-center gap-1">
              <MessagesSquare size={11} strokeWidth={1.75} aria-hidden />
              {names.sessionTitle(task.targetSessionId)}
            </span>
          )}
        </div>
      )}
      {task.status === 'in_progress' && task.startedAt && (
        <div className="mt-1 text-[11px] text-tertiary">
          已用 {Math.round((Date.now() - task.startedAt) / 60000)} min · {task.toolCallsUsed} 工具调用
        </div>
      )}
    </button>
  );
}
