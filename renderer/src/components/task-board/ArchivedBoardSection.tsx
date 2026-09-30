// renderer/src/components/task-board/ArchivedBoardSection.tsx
//
// 归档看板只读泳道（归档组点击 → 主区只读看板改造）：
//   - 泳道头：组色点（groupColorStyle 语义 token）+ 组名 + 计数 +
//     「已归档 · 只读」标识（Archive 图标 + 文案）；无 GroupMenu（归档组无操作）
//   - 列体：BOARD_COLUMNS × BoardColumn 静态渲染通道——不传 renderCard /
//     droppableId，BoardColumn 内部渲染纯展示 BoardCard（静态渲染脱离
//     DndContext 安全，见 BoardColumn 头注）；卡片可点击选中（selectedId /
//     onSelect 透传静态通道 → 打开只读详情抽屉，TaskDetailPanel 按
//     archivedAt 派生只读）；无 sortable——不可拖拽
//   - 只读保证：整个组件不包 DndContext、不出现 useSortable /
//     SortableContext、右键捕获拦截不弹 BoardCard 任务菜单（编辑/归档入口
//     对归档任务不可达）；详情查看入口保留（抽屉内只读渲染）
//   - 横向布局参照 Lane 展开态（flex gap-3 overflow-x-auto），外层滚动容器
//     参照 BoardCanvas（flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3）
//
// 数据由 TaskBoardView 拉取后按 props 传入（group + 该组归档任务行），
// 本组件零数据依赖、零交互副作用。
import { type CSSProperties } from 'react';
import { Archive } from 'lucide-react';
import { BOARD_COLUMNS } from '../../ipc/board-columns';
import { groupColorStyle } from '../../lib/board';
import type { GroupRow, TaskRow } from '../../ipc/types';
import { BoardColumn } from './BoardColumn';

interface ArchivedBoardSectionProps {
  group: GroupRow;
  tasks: TaskRow[];
  /** 选中任务 id（详情抽屉驱动）；null=无选中 */
  selectedId: string | null;
  /** 点卡片 → 选中（TaskBoardView 接 task.store.setSelectedTaskId 开抽屉） */
  onSelect: (id: string) => void;
}

export function ArchivedBoardSection({ group, tasks, selectedId, onSelect }: ArchivedBoardSectionProps) {
  // 组色点：语义色 token（与 Lane 泳道头同款），未知/无色回退中性
  const colorCss = groupColorStyle(group.color);
  const dotStyle: CSSProperties = colorCss
    ? { backgroundColor: colorCss }
    : { backgroundColor: 'rgb(var(--text-tertiary))' };

  return (
    <section
      aria-label={`归档看板 ${group.name}`}
      onContextMenuCapture={(e) => {
        // 捕获阶段拦截（祖先捕获先于卡片 handler）：只读视图禁 BoardCard
        // 右键任务菜单（编辑/归档入口对归档任务不可达）
        e.preventDefault();
        e.stopPropagation();
      }}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
    >
      <header className="flex shrink-0 items-center gap-1.5 px-0.5">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-secondary">
          <i aria-hidden className="inline-block h-2 w-2 rounded-[2px]" style={dotStyle} />
          {group.name}
          <span className="font-normal text-tertiary">{tasks.length}</span>
        </h3>
        <span className="inline-flex items-center gap-0.5 text-[11px] font-normal text-tertiary">
          <Archive size={12} strokeWidth={1.75} aria-hidden />
          已归档 · 只读
        </span>
      </header>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {BOARD_COLUMNS.map((column) => (
          <BoardColumn
            key={column.key}
            column={column}
            tasks={tasks.filter((t) => column.statuses.includes(t.status))}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}
