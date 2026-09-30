// renderer/src/components/task-board/Lane.tsx
//
// 看板泳道（看板重构 Task 12，spec §5.1）：
//   - LaneHeader（仅泳道模式渲染；平铺=单道无 header）：组色标（groupColorStyle
//     语义色 token）/ 组名 / 任务计数 / 折叠 chevron / 组菜单 GroupMenu
//     （重命名·换色·归档组——Task 14 经 useGroupActions 公共逻辑实装；
//     未分组道无菜单）
//   - 折叠态只留 header；展开态 5 列横排（BoardColumn × BOARD_COLUMNS）
//   - 卡片渲染由 BoardCanvas 注入（SortableBoardCard）；拖拽手持源状态
//     透传 BoardColumn 做禁投预判（canDropIntoColumn → droppable disabled + 变暗）；
//     拖悬目标列高亮按 dropHint（column+groupId）匹配透传（排序退役后
//     替代插入指示线的落点反馈）
import { useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { BOARD_COLUMNS } from '../../ipc/board-columns';
import { groupColorStyle, type BoardLane } from '../../lib/board';
import type { TaskRow, TaskStatus } from '../../ipc/types';
import { BoardColumn } from './BoardColumn';
import { GroupMenu } from './GroupMenu';
import type { DropHint } from './useBoardDrop';

interface LaneProps {
  lane: BoardLane;
  laneMode: 'flat' | 'lanes';
  /** 卡片渲染器（BoardCanvas 注入的 SortableBoardCard） */
  renderCard: (task: TaskRow) => ReactNode;
  /** 拖拽手持卡的源状态（null=无拖拽）；透传 BoardColumn 做禁投预判 */
  activeDragStatus: TaskStatus | null;
  /** 拖悬目标列（null=无拖拽/禁投/同列同组 no-op） */
  dropHint?: DropHint | null;
}

export function Lane({ lane, laneMode, renderCard, activeDragStatus, dropHint = null }: LaneProps) {
  const [collapsed, setCollapsed] = useState(false);
  const name = lane.group?.name ?? '未分组';
  const count = lane.tasks.length;
  const laneKey = laneMode === 'flat' ? 'flat' : (lane.group?.id ?? 'ungrouped');
  // 组色点：语义色 token（设计系统唯一豁免的 inline 色），未知/无色回退中性
  const colorStyle = groupColorStyle(lane.group?.color ?? null);
  const dotStyle: CSSProperties = { backgroundColor: colorStyle ?? 'rgb(var(--text-tertiary))' };
  const laneGroupId = lane.group?.id ?? null;

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
          {/* 组菜单（Task 14 实装）：重命名/换色/归档组走 GroupMenu 公共逻辑；
              未分组道（group=null）无菜单 */}
          {lane.group !== null && (
            <GroupMenu group={lane.group} triggerLabel={`泳道菜单 ${name}`} />
          )}
        </header>
      )}
      {!collapsed && (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {BOARD_COLUMNS.map((column) => {
            const droppableId = `col:${laneKey}:${column.key}`;
            // 目标列匹配：泳道模式列+组双匹配；平铺单道只比列（groupId 是
            // active 现组，与本道无关）
            const dropTargetActive =
              dropHint !== null &&
              dropHint.column === column.key &&
              (laneMode === 'flat' || dropHint.groupId === laneGroupId);
            return (
              <BoardColumn
                key={column.key}
                column={column}
                tasks={lane.tasks.filter((t) => column.statuses.includes(t.status))}
                droppableId={droppableId}
                dropFromStatus={activeDragStatus}
                renderCard={renderCard}
                dropTargetActive={dropTargetActive}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
