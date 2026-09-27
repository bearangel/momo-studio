// renderer/src/components/task-board/BoardColumn.tsx
//
// 看板列（看板重构 Task 11 建立，Task 12 拖拽升级）：
//   - 独立圆角卡容器：bg-surface-1 + border-subtle，固定列宽 ~232px（mockup 基线）
//   - 列头：列名 + 卡片计数 + hint 灰字（BOARD_COLUMNS 契约的 statuses 标注）
//   - 列体：sortColumn 内部排序（boardPosition 升序 NULL 垫底）→ 卡片列表；
//     空列显示「暂无」空态
//   - Task 12 拖拽接线：
//     * droppableId 传入 → useDroppable 列容器（空列/列尾落点）；缺省静态渲染
//       仍安全（dnd-kit 默认 context dispatch=noop，不炸独立渲染）
//     * dropFromStatus（拖拽手持卡源状态）→ canDropIntoColumn 禁投预判：
//       droppable disabled + 列变暗（spec §4「待办只出不进」等列级投影）；
//       可投列拖悬高亮 border-focus
//     * renderCard 注入（BoardCanvas 的 SortableBoardCard + SortableContext）；
//       缺省渲染静态 BoardCard（Task 11 行为，selectedId/onSelect 走旧通道）
import type { ReactNode } from 'react';
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
}: BoardColumnProps) {
  const sorted = sortColumn(tasks);
  const dropForbidden = dropFromStatus !== null && !canDropIntoColumn(dropFromStatus, column.key);
  const { setNodeRef, isOver } = useDroppable({
    id: droppableId ?? `static-col:${column.key}`,
    disabled: dropForbidden,
  });

  return (
    <section
      ref={setNodeRef}
      aria-label={column.label}
      className={`flex w-[232px] shrink-0 flex-col rounded-lg border bg-surface-1 ${
        dropForbidden
          ? 'border-subtle opacity-50' // 禁投列变暗（spec §4 列级投影）
          : isOver && dropFromStatus !== null
            ? 'border-focus' // 拖悬可投列高亮
            : 'border-subtle'
      }`}
    >
      <header className="flex items-center gap-1.5 border-b border-subtle px-2.5 pb-1.5 pt-2 text-xs font-semibold text-secondary">
        <span>{column.label}</span>
        <span className="text-[11px] font-normal text-tertiary">{tasks.length}</span>
        {column.hint !== '' && (
          <span className="ml-auto text-[11px] font-normal text-tertiary">{column.hint}</span>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {sorted.length === 0 ? (
          <div className="py-6 text-center text-xs text-tertiary">暂无</div>
        ) : renderCard ? (
          <SortableContext items={sorted.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            {sorted.map((task) => renderCard(task))}
          </SortableContext>
        ) : (
          sorted.map((task) => (
            <BoardCard
              key={task.id}
              task={task}
              selected={task.id === selectedId}
              onClick={() => onSelect?.(task.id)}
              groupChip={groupChipOf ? groupChipOf(task) : null}
            />
          ))
        )}
      </div>
    </section>
  );
}
