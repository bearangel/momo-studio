// renderer/src/components/task-board/Lane.tsx
//
// 看板泳道（看板重构 Task 12，spec §5.1）：
//   - LaneHeader（仅泳道模式渲染；平铺=单道无 header）：组色标（groupColorStyle
//     语义色 token）/ 组名 / 任务计数 / 折叠 chevron / 组菜单 MoreHorizontal
//     （重命名·换色·归档组——Task 14 实装，本任务禁用占位）
//   - 折叠态只留 header；展开态 5 列横排（BoardColumn × BOARD_COLUMNS）
//   - 卡片渲染由 BoardCanvas 注入（SortableBoardCard）；拖拽手持源状态
//     透传 BoardColumn 做禁投预判（canDropIntoColumn → droppable disabled + 变暗）
import { useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import { BOARD_COLUMNS } from '../../ipc/board-columns';
import { groupColorStyle, type BoardLane } from '../../lib/board';
import type { TaskRow, TaskStatus } from '../../ipc/types';
import { BoardColumn } from './BoardColumn';

interface LaneProps {
  lane: BoardLane;
  laneMode: 'flat' | 'lanes';
  /** 卡片渲染器（BoardCanvas 注入的 SortableBoardCard） */
  renderCard: (task: TaskRow) => ReactNode;
  /** 拖拽手持卡的源状态（null=无拖拽）；透传 BoardColumn 做禁投预判 */
  activeDragStatus: TaskStatus | null;
}

export function Lane({ lane, laneMode, renderCard, activeDragStatus }: LaneProps) {
  const [collapsed, setCollapsed] = useState(false);
  const name = lane.group?.name ?? '未分组';
  const count = lane.tasks.length;
  const laneKey = laneMode === 'flat' ? 'flat' : (lane.group?.id ?? 'ungrouped');
  // 组色点：语义色 token（设计系统唯一豁免的 inline 色），未知/无色回退中性
  const colorStyle = groupColorStyle(lane.group?.color ?? null);
  const dotStyle: CSSProperties = { backgroundColor: colorStyle ?? 'rgb(var(--text-tertiary))' };

  return (
    <section aria-label={laneMode === 'flat' ? '任务泳道' : `泳道 ${name}`} className="flex flex-col gap-1.5">
      {laneMode === 'lanes' && (
        <header className="flex items-center gap-1.5 px-0.5">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold text-secondary">
            <i aria-hidden className="inline-block h-2 w-2 rounded-[2px]" style={dotStyle} />
            {name}
            <span className="font-normal text-tertiary">{count}</span>
          </h3>
          <button
            type="button"
            aria-label={collapsed ? `展开泳道 ${name}` : `折叠泳道 ${name}`}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((v) => !v)}
            className="rounded px-0.5 leading-none text-tertiary hover:text-primary"
          >
            {collapsed ? (
              <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
            ) : (
              <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
            )}
          </button>
          {/* 组菜单：重命名/换色/归档组 Task 14 实装，先禁用占位（Popover 原子件届时引入） */}
          <details className="relative ml-auto">
            <summary
              aria-label={`泳道菜单 ${name}`}
              className="cursor-pointer list-none rounded px-0.5 leading-none text-tertiary hover:text-primary [&::-webkit-details-marker]:hidden"
            >
              <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden />
            </summary>
            <div className="absolute right-0 z-10 mt-1 w-28 rounded-md border border-subtle bg-canvas py-1 text-xs shadow-lg">
              <button
                type="button"
                disabled
                className="block w-full px-3 py-1 text-left text-secondary disabled:opacity-50"
              >
                重命名
              </button>
              <button
                type="button"
                disabled
                className="block w-full px-3 py-1 text-left text-secondary disabled:opacity-50"
              >
                换色
              </button>
              <button
                type="button"
                disabled
                className="block w-full px-3 py-1 text-left text-secondary disabled:opacity-50"
              >
                归档组
              </button>
            </div>
          </details>
        </header>
      )}
      {!collapsed && (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {BOARD_COLUMNS.map((column) => (
            <BoardColumn
              key={column.key}
              column={column}
              tasks={lane.tasks.filter((t) => column.statuses.includes(t.status))}
              droppableId={`col:${laneKey}:${column.key}`}
              dropFromStatus={activeDragStatus}
              renderCard={renderCard}
            />
          ))}
        </div>
      )}
    </section>
  );
}
