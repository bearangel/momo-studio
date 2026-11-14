// renderer/src/components/task-board/BoardColumn.tsx
//
// 看板列（看板重构 Task 11 建立，Task 12 拖拽升级；2026-11-11 流式布局改造）：
//   - 独立圆角卡容器：bg-surface-1 + border-subtle；列宽自适应——flex-1 沿
//     BOARD_COLUMNS 列数均分（v2 生命周期起七列）+ min-w-[184px] 下限（预览定值
//     合同 .omo/previews/board-fluid-lane-layout.html：内容区窄于列最小总宽时由
//     泳道容器 overflow-x-auto 回退横向滚动）
//   - 列头：列名 + 卡片计数 + hint 灰字（BOARD_COLUMNS 契约的 statuses 标注）；
//     hint 窄列下省略号截断（min-w-0 + truncate，防长副标挤爆列头）
//   - 列体：sortColumn 内部排序（顶置组 pin 时间倒序 → 未顶置创建时间倒序，
//     2026-09-30 排序收敛）→ 卡片流式网格（auto-fill minmax(168px,1fr)，列宽
//     时多卡/行换行铺满）；「顶置以上」分隔线与空态「暂无」col-span-full 占满整行
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
import { Ban, Check, Pin } from 'lucide-react';
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
    <div data-testid="pinned-divider" className="col-span-full flex items-center gap-1 text-[10px] text-tertiary">
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
  // 验收通过拖悬提示条（预览定值清单 #14）：仅 submitted 卡悬停 done 列出现——
  // 松手即验收通过（move 直达），其余合法落点走既有 over 态列高亮（#13）
  const acceptHintVisible = dropTargetActive && dropFromStatus === 'submitted' && column.key === 'done';

  return (
    <section
      ref={setNodeRef}
      aria-label={column.label}
      data-drop-state={dropState}
      className={`flex min-w-[184px] flex-1 flex-col rounded-lg border bg-surface-1 ${dropStateClass}`}
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
          <span className="ml-auto min-w-0 flex-1 truncate text-right text-[11px] font-normal text-tertiary">{column.hint}</span>
        )}
      </header>
      {acceptHintVisible && (
        <div
          data-testid="accept-drop-hint"
          className="mx-2 mt-2 flex h-6 shrink-0 items-center justify-center gap-1 rounded-md bg-surface-active text-[11px] font-medium text-accent-600 dark:text-accent-300"
        >
          <Check size={11} strokeWidth={1.75} aria-hidden />
          松开 → 验收通过
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(168px,1fr))] content-start gap-2 overflow-y-auto p-2">
        {sorted.length === 0 ? (
          <div className="col-span-full py-6 text-center text-xs text-tertiary">暂无</div>
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
