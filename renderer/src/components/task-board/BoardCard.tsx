// renderer/src/components/task-board/BoardCard.tsx
//
// 看板卡片（看板重构 Task 11，spec §5.2）——从 TaskCard 派生：
//   - 独立圆角卡：bg-canvas + border-subtle，hover 边框加深（border-strong）
//   - 标题行：[优先级] 前缀 + #短ID · 标题 + 状态徽标（task-status.ts 单源，
//     中间态 session_queued→「排队中」/ paused→「已暂停」由徽标天然表达，不占列）
//   - 元信息行复用 TaskCard 内容：日程/截止/指派 agent/循环/委派目标
//   - 平铺模式补显 groupChip（色点+组名，spec §5.2）；泳道模式（Task 12）组即道省略
//   - 终态卡（done/closed 列）右键「归档」菜单（spec §5.2）：调 task.store.archive
//     （成功即本地剔除，卡片消失）；失败 toast。非终态不出菜单（主进程同样 reject）
import { Archive, Bot, Calendar, Clock, MessagesSquare, Repeat, Users } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import type { TaskRow } from '../../ipc/types';
import { taskStatusStyle } from '../../lib/task-status';
import { groupColorStyle, isTerminalStatus } from '../../lib/board';
import { humanizeRecurrence } from '../../lib/recurrence';
import { useTaskStore } from '../../stores/task.store';
import { showToast } from '../ui/Toast';
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
  // 右键归档菜单定位（null=关）；仅终态卡可开（spec §5.2）
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const canArchive = isTerminalStatus(task.status);
  // 组色点：groupColorStyle 返回 token 形式的 CSS 变量串（设计系统唯一豁免的
  // inline 色），未知/无色 → 中性 tertiary
  const dotColor = groupChip ? groupColorStyle(groupChip.color) : null;
  const dotStyle: CSSProperties | undefined = dotColor
    ? { backgroundColor: dotColor }
    : { backgroundColor: 'rgb(var(--text-tertiary))' };

  const handleArchive = async (): Promise<void> => {
    try {
      // store.archive：IPC 成功即本地剔除 tasks 行（卡片随之消失）
      await useTaskStore.getState().archive(task.id);
    } catch (err) {
      showToast(`归档失败: ${(err as Error).message}`);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onClick}
        onContextMenu={(e) => {
          if (!canArchive) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
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
      {menu && (
        <>
          {/* 全屏遮罩：点击或右键关闭菜单（照 FileContextMenu 先例） */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <ul
            aria-label={`任务菜单 ${task.title}`}
            className="fixed z-50 min-w-[120px] rounded border border-subtle bg-surface-1 py-1 text-sm text-secondary shadow-lg"
            style={{ left: menu.x, top: menu.y }}
          >
            <li>
              <button
                type="button"
                onClick={() => {
                  setMenu(null);
                  void handleArchive();
                }}
                className="flex w-full items-center gap-1.5 px-3 py-1 text-left hover:bg-surface-3"
              >
                <Archive size={12} strokeWidth={1.75} aria-hidden />
                归档
              </button>
            </li>
          </ul>
        </>
      )}
    </>
  );
}
