// renderer/src/components/task-board/BoardColumn.tsx
//
// 看板列（看板重构 Task 11，spec §5.1/§5.2）：
//   - 独立圆角卡容器：bg-surface-1 + border-subtle，固定列宽 ~232px（mockup 基线）
//   - 列头：列名 + 卡片计数 + hint 灰字（BOARD_COLUMNS 契约的 statuses 标注）
//   - 列体：sortColumn 内部排序（boardPosition 升序 NULL 垫底）→ BoardCard 列表；
//     空列显示「暂无」空态
// 职责边界：本组件不做 status→列分桶（TaskBoardView 按 column.statuses 分好后传入），
// 也不接拖拽（Task 12 由 @dnd-kit SortableContext 包装升级）。
import type { BoardColumnDef } from '../../ipc/board-columns';
import type { TaskRow } from '../../ipc/types';
import { sortColumn } from '../../lib/board';
import { BoardCard, type BoardGroupChip } from './BoardCard';

interface BoardColumnProps {
  column: BoardColumnDef;
  /** 本列任务（调用方按 column.statuses 分桶后传入）；列内排序在本组件内完成 */
  tasks: TaskRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 平铺模式组 chip 解析表（Task 12 泳道模式传 null 省略 chip） */
  groupChipOf?: (task: TaskRow) => BoardGroupChip | null;
}

export function BoardColumn({ column, tasks, selectedId, onSelect, groupChipOf }: BoardColumnProps) {
  const sorted = sortColumn(tasks);
  return (
    <section
      aria-label={column.label}
      className="flex w-[232px] shrink-0 flex-col rounded-lg border border-subtle bg-surface-1"
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
        ) : (
          sorted.map((task) => (
            <BoardCard
              key={task.id}
              task={task}
              selected={task.id === selectedId}
              onClick={() => onSelect(task.id)}
              groupChip={groupChipOf ? groupChipOf(task) : null}
            />
          ))
        )}
      </div>
    </section>
  );
}
