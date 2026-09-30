// renderer/src/components/task-board/BoardCard.tsx
//
// 看板卡片（看板重构 Task 11，spec §5.2）——从 TaskCard 派生：
//   - 独立圆角卡：bg-canvas + border-subtle，hover 边框加深（border-strong）
//   - 标题行：[优先级] 前缀 + #短ID · 标题 + 状态徽标（task-status.ts 单源，
//     中间态 session_queued→「排队中」/ paused→「已暂停」由徽标天然表达，不占列）
//   - 元信息行复用 TaskCard 内容：日程/截止/指派 agent/循环/委派目标
//   - 平铺模式补显 groupChip（组色低透明底 + 组色文字，UX 波 2 #7；fg/bg 由
//     BoardCanvas 用 lib/board.groupChipColor 解析传入）；泳道模式组即道省略
//   - 右键菜单全状态（UX 波 2 #1：原入口太隐蔽）：可编辑态（draft/pending，
//     isEditableStatus 单源）出「编辑」（内嵌 EditTaskDialog，props 照
//     TaskDetailPanel 先例）；执行管线中间态（assigned/session_queued/
//     in_progress/paused）无编辑无归档——仅顶置；终态保留「归档」（spec
//     §5.2）：调 task.store.archive（成功即本地剔除，卡片消失）；失败 toast
import { Archive, Bot, Calendar, Clock, MessagesSquare, Pencil, Pin, PinOff, Repeat, Users } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import type { TaskRow } from '../../ipc/types';
import { PENDING_WRAP_UP_STYLE, taskStatusStyle } from '../../lib/task-status';
import { isEditableStatus, isTerminalStatus } from '../../lib/board';
import { humanizeRecurrence } from '../../lib/recurrence';
import { useTaskStore } from '../../stores/task.store';
import { showToast } from '../ui/Toast';
import { EditTaskDialog } from './EditTaskDialog';
import { useTaskEntityNames } from './useTaskEntityNames';
import { usePendingWrapUp } from './usePendingWrapUp';

/** 优先级标签（0=无 / 1=低 / 5=中 / 10=高）——与 TaskCard 同源词表 */
const PRIORITY_LABEL: Record<number, string> = { 0: '', 1: '低', 5: '中', 10: '高' };

/**
 * 平铺模式组 chip 数据（由父层从 group.store 组装；UX 波 2 #7：fg/bg 为
 * groupChipColor 解析后的配色串，null=未知/无色 → 中性样式回退）
 */
export interface BoardGroupChip {
  name: string;
  color: string | null;
  /** 前景（文字/边框）色串；null=未解析出组色 */
  fg: string | null;
  /** 低透明底色串；null=未解析出组色 */
  bg: string | null;
}

interface BoardCardProps {
  task: TaskRow;
  selected: boolean;
  onClick: () => void;
  /** 平铺模式所属组 chip；null / 不传 = 不渲染（泳道模式） */
  groupChip?: BoardGroupChip | null;
}

/** 组色 chip 的 inline 配色（用户内容色豁免设计系统禁 inline 色——UI chrome 才受限） */
function chipStyle(fg: string, bg: string): CSSProperties {
  return { backgroundColor: bg, color: fg, borderColor: fg };
}

export function BoardCard({ task, selected, onClick, groupChip }: BoardCardProps) {
  const status = taskStatusStyle(task.status);
  // 派生「待收尾」（spec §3.5）：与状态徽标并列的提示，不替换 in_progress 真相
  const pendingWrapUp = usePendingWrapUp(task);
  const priorityLabel = PRIORITY_LABEL[task.priority];
  const names = useTaskEntityNames(task.workspaceId);
  // 右键菜单定位（null=关）；全状态可开——可编辑态出「编辑」/ 终态出「归档」（UX 波 2 #1）
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 可编辑态卡的内嵌编辑对话框开关（打开瞬间的 task 快照喂给 EditTaskDialog）
  const [editOpen, setEditOpen] = useState(false);
  const canArchive = isTerminalStatus(task.status);
  const canEdit = isEditableStatus(task.status);

  const handleArchive = async (): Promise<void> => {
    try {
      // store.archive：IPC 成功即本地剔除 tasks 行（卡片随之消失）
      await useTaskStore.getState().archive(task.id);
    } catch (err) {
      showToast(`归档失败: ${(err as Error).message}`);
    }
  };

  const handlePin = async (pinned: boolean): Promise<void> => {
    try {
      // store.pin：乐观置 pinnedAt（排序即时生效），失败回滚 + toast
      await useTaskStore.getState().pin(task.id, pinned);
    } catch (err) {
      showToast(`顶置失败: ${(err as Error).message}`);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onClick}
        onContextMenu={(e) => {
          // 全状态拦截原生菜单（UX 波 2 #1：原非终态放行原生菜单，入口形同虚设）
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
        <span className="flex shrink-0 items-center gap-1">
          {task.pinnedAt !== null && (
            <Pin
              size={12}
              strokeWidth={1.75}
              fill="currentColor"
              fillOpacity={0.25}
              aria-label="已顶置"
              className="shrink-0 text-accent-500"
            />
          )}
          <span className={status.className}>{status.label}</span>
          {pendingWrapUp && (
            <span className={PENDING_WRAP_UP_STYLE.className} title="任务仍在进行，但宿主会话当前没有运行回合">
              {PENDING_WRAP_UP_STYLE.label}
            </span>
          )}
        </span>
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
            groupChip.fg !== null && groupChip.bg !== null ? (
              <span
                className="inline-flex items-center rounded-sm border px-1.5 py-px font-medium"
                style={chipStyle(groupChip.fg, groupChip.bg)}
              >
                {groupChip.name}
              </span>
            ) : (
              <span className="inline-flex items-center rounded-sm bg-surface-2 px-1.5 py-px">
                {groupChip.name}
              </span>
            )
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
            {/* 顶置开关（迁移 050）：全状态可用；重复 pin 刷新时间戳=重新压顶 */}
            <li>
              <button
                type="button"
                onClick={() => {
                  setMenu(null);
                  void handlePin(task.pinnedAt === null);
                }}
                className="flex w-full items-center gap-1.5 px-3 py-1 text-left hover:bg-surface-3"
              >
                {task.pinnedAt === null ? (
                  <Pin size={12} strokeWidth={1.75} aria-hidden />
                ) : (
                  <PinOff size={12} strokeWidth={1.75} aria-hidden />
                )}
                {task.pinnedAt === null ? '顶置' : '取消顶置'}
              </button>
            </li>
            {canArchive ? (
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
            ) : canEdit ? (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(null);
                    setEditOpen(true);
                  }}
                  className="flex w-full items-center gap-1.5 px-3 py-1 text-left hover:bg-surface-3"
                >
                  <Pencil size={12} strokeWidth={1.75} aria-hidden />
                  编辑
                </button>
              </li>
            ) : null}
          </ul>
        </>
      )}
      {canEdit && (
        <EditTaskDialog
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            // store.update 已本地更新 tasks 行，卡片随父层 store 订阅重渲染，无需额外刷新
          }}
          task={task}
          workspaceId={task.workspaceId}
        />
      )}
    </>
  );
}
