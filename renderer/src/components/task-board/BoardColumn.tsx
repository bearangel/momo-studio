// renderer/src/components/task-board/BoardColumn.tsx
//
// 看板列（看板重构 Task 11 建立，Task 12 拖拽升级）：
//   - 独立圆角卡容器：bg-surface-1 + border-subtle，固定列宽 ~232px（mockup 基线）
//   - 列头：列名 + 卡片计数 + hint 灰字（BOARD_COLUMNS 契约的 statuses 标注）
//   - 列体：sortColumn 内部排序（顶置组 pin 时间倒序 → 未顶置创建时间倒序，
//     2026-09-30 排序收敛）→ 卡片列表；两组之间渲染「顶置以上」分隔线；
//     空列显示「暂无」空态
//   - Task 12 拖拽接线：
//     * droppableId 传入 → useDroppable 列容器（跨列/跨泳道落点）；缺省静态渲染
//       仍安全（dnd-kit 默认 context dispatch=noop，不炸独立渲染）
//     * dropFromStatus（拖拽手持卡源状态）→ canDropIntoColumn 禁投预判：
//       droppable disabled + 列变暗（spec §4「待办只出不进」等列级投影）
//     * dropTargetActive（排序退役后的拖悬反馈）：resolveDrop 产出的目标列
//       高亮（悬卡片时列容器 isOver 不触发，经 Lane 匹配透传补位）
//     * renderCard 注入（BoardCanvas 的 SortableBoardCard + SortableContext）；
//       缺省渲染静态 BoardCard（Task 11 行为，selectedId/onSelect 走旧通道）
import { Fragment, type ReactNode } from 'react';
import { Ban, Pin } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { canDropIntoColumn, type BoardColumnDef } from '../../ipc/board-columns';
import type { TaskRow, TaskStatus } from '../../ipc/types';
import { sortColumn } from '../../lib/board';
import { BoardCard, type BoardGroupChip } from './BoardCard';

interface BoardColumnProps {
  column: BoardColumnDef;
  /** 本列任务（调用方按 column.statuses 分桶后传入）；列内排序在本组件内完成 */
  tasks: TaskRow[];
  /** 静态渲染通道选中态（renderCard 注入时由渲染器自带，可省） */
  selectedId?: string | null;
  /** 静态渲染通道选中回调（同上可省） */
  onSelect?: (id: string) => void;
  /** 平铺模式组 chip 解析表（Task 12 泳道模式传 null 省略 chip） */
  groupChipOf?: (task: TaskRow) => BoardGroupChip | null;
  /** 拖拽列容器 droppable id（`col:{laneKey}:{columnKey}` 规约见 BoardCanvas） */
  droppableId?: string;
  /** 拖拽手持卡源状态；null=无拖拽（列正常亮度） */
  dropFromStatus?: TaskStatus | null;
  /** 卡片渲染注入（SortableBoardCard）；缺省静态 BoardCard */
  renderCard?: (task: TaskRow) => ReactNode;
  /** 拖悬目标列高亮（Lane 按 dropHint 匹配透传；false=常规亮度） */
  dropTargetActive?: boolean;
}

/** 顶置分区线（图钉 + 「顶置以上」+ 细线）——pinned 组与未 pin 组的分界 */
function PinnedDivider(): ReactNode {
  return (
    <div data-testid="pinned-divider" className="flex items-center gap-1 text-[10px] text-tertiary">
      <Pin size={10} strokeWidth={1.75} aria-hidden className="shrink-0" />
      顶置以上
      <span aria-hidden className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}

export function BoardColumn({
  column,
  tasks,
  selectedId = null,
  onSelect,
  groupChipOf,
  droppableId,
  dropFromStatus = null,
  renderCard,
  dropTargetActive = false,
}: BoardColumnProps) {
  const sorted = sortColumn(tasks);
  const dropForbidden = dropFromStatus !== null && !canDropIntoColumn(dropFromStatus, column.key);
  const { setNodeRef, isOver } = useDroppable({
    id: droppableId ?? `static-col:${column.key}`,
    disabled: dropForbidden,
  });
  // 拖拽视觉三态(Task 13):forbidden 禁投变暗 / over 拖悬升级 / ok 可投虚线 / idle 常规；
  // dropTargetActive 把悬停在卡片上的目标列也纳入 over 态（列容器自身 isOver 不触发）
  const dropState = dropForbidden
    ? 'forbidden'
    : dropFromStatus !== null
      ? isOver || dropTargetActive
        ? 'over'
        : 'ok'
      : 'idle';
  const dropStateClass =
    dropState === 'forbidden'
      ? 'border-subtle opacity-50'
      : dropState === 'over'
        ? 'border-dashed border-focus bg-surface-2'
        : dropState === 'ok'
          ? 'border-dashed border-focus'
          : 'border-subtle';
  // 顶置分界：排序后首个未顶置卡的位置（≤0=无顶置卡不画线；=length=全顶置不画线）
  const firstUnpinnedIdx = sorted.findIndex((t) => t.pinnedAt === null);

  return (
    <section
      ref={setNodeRef}
      aria-label={column.label}
      data-drop-state={dropState}
      className={`flex w-[232px] shrink-0 flex-col rounded-lg border bg-surface-1 ${dropStateClass}`}
    >
      <header className="flex items-center gap-1.5 border-b border-subtle px-2.5 pb-1.5 pt-2 text-xs font-semibold text-secondary">
        <span>{column.label}</span>
        <span className="text-[11px] font-normal text-tertiary">{tasks.length}</span>
        {dropState === 'forbidden' && (
          <span className="inline-flex items-center gap-0.5 text-[11px] font-normal text-tertiary">
            <Ban size={11} strokeWidth={1.75} aria-hidden />
            不可投放
          </span>
        )}
        {column.hint !== '' && (
          <span className="ml-auto text-[11px] font-normal text-tertiary">{column.hint}</span>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {sorted.length === 0 ? (
          <div className="py-6 text-center text-xs text-tertiary">暂无</div>
        ) : renderCard ? (
          <SortableContext items={sorted.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            {sorted.map((task, idx) => (
              <Fragment key={task.id}>
                {idx === firstUnpinnedIdx && firstUnpinnedIdx > 0 && <PinnedDivider />}
                {renderCard(task)}
              </Fragment>
            ))}
          </SortableContext>
        ) : (
          sorted.map((task, idx) => (
            <Fragment key={task.id}>
              {idx === firstUnpinnedIdx && firstUnpinnedIdx > 0 && <PinnedDivider />}
              <BoardCard
                task={task}
                selected={task.id === selectedId}
                onClick={() => onSelect?.(task.id)}
                groupChip={groupChipOf ? groupChipOf(task) : null}
              />
            </Fragment>
          ))
        )}
      </div>
    </section>
  );
}
