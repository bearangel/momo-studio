// renderer/src/components/task-board/BoardCanvas.tsx
//
// 看板画板拖拽编排（看板重构 Task 12，spec §4/§5.1/§6）：
//   - DndContext（PointerSensor 距离激活 + KeyboardSensor 方向键排序）包裹整个板，
//     Lane × N 泳道渲染（泳道模式 splitLanes 切道；平铺模式单道）
//   - DragOverlay：微倾跟手卡片；原位 sortable 卡变虚线洞（Lane 内 SortableBoardCard）
//   - onDragStart → task.store.setDragging(true)（5s 轮询跳过，防手上列表跳动）；
//     onDragEnd → resolveDrop 纯函数裁决 → task.store.move（乐观+回滚已内置），
//     失败 console.error——toast 文案统一在 Task 13 接入
//   - 拖拽三分支语义（spec §4 裁决表）：同列同泳道=纯排序（before/after 邻居透传）、
//     同列跨泳道=换组、跨列=column 变化；renderer 只发落点，动作裁决单点在主进程
//     executeMove。in_progress→done/closed 的确认框是 Task 13，本任务直接发 move
//
// 纯函数出口（单测主战场，BoardCanvas.test.tsx）：
//   - resolveDrop：落点裁决（禁投预判 canDropIntoColumn 单源 → null）
//   - buildDropIndex / buildDropTarget：dnd over.id → 落点目标组装
import { useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useSortable } from '@dnd-kit/sortable';
import { BOARD_COLUMNS, canDropIntoColumn, columnOf, type BoardColumnKey } from '../../ipc/board-columns';
import { splitLanes, sortColumn, type BoardLane } from '../../lib/board';
import type { GroupRow, TaskRow } from '../../ipc/types';
import { useTaskStore } from '../../stores/task.store';
import { BoardCard, type BoardGroupChip } from './BoardCard';
import { Lane } from './Lane';

/** PointerSensor 激活位移阈值（px）：小于该位移视为点击（选中卡片），不启动拖拽 */
const DRAG_ACTIVATION_DISTANCE_PX = 5;

// ── 落点裁决纯函数 ────────────────────────────────────────────────────────────

/** dnd over 目标：落卡片（带 taskId）或列容器（空列/列尾落点） */
export type DropOverTarget =
  | { type: 'card'; taskId: string; column: BoardColumnKey; groupId: string | null }
  | { type: 'column'; column: BoardColumnKey; groupId: string | null };

/**
 * over.groupId 语义：目标组。泳道模式=落点泳道的组（未分组道 null，跨泳道拖=换组）；
 * 平铺模式由调用方传 active 任务现组——单道无组语义，纯排序不换组。
 */
export interface DropCtx {
  tasks: TaskRow[];
  /** 泳道模式：落点泳道的任务 id 集（可见序裁剪范围）；平铺模式省略=整列可见序 */
  laneTaskIds?: Set<string>;
}

/** 落点决议：与 ipc.task.move 的 target 契约完全对齐 */
export interface DropResolution {
  column: BoardColumnKey;
  groupId: string | null;
  /** 落点上方位可见邻居 */
  beforeTaskId?: string;
  /** 落点下方位可见邻居 */
  afterTaskId?: string;
}

/**
 * 拖拽落点裁决（纯函数）：
 *   - active 不在 ctx.tasks / 目标列禁投（canDropIntoColumn 单源）/ over 卡=自身 → null
 *   - over 卡片：同列可见序中算落槽邻居——同序下移落 over 卡之下（before=over 卡），
 *     上移与跨源（跨列/跨泳道）默认插 over 卡之上（after=over 卡）
 *   - over 列容器：列尾（afterTaskId=泳道内末卡，空列无锚点）
 *   - over 卡片不在目标可见序（泳道外/数据不一致）→ null
 */
export function resolveDrop(activeId: string, over: DropOverTarget, ctx: DropCtx): DropResolution | null {
  const activeTask = ctx.tasks.find((t) => t.id === activeId);
  if (!activeTask) return null;
  if (!canDropIntoColumn(activeTask.status, over.column)) return null;
  if (over.type === 'card' && over.taskId === activeId) return null;

  const inLaneScope = (t: TaskRow): boolean => ctx.laneTaskIds === undefined || ctx.laneTaskIds.has(t.id);
  const fullSeq = sortColumn(ctx.tasks.filter((t) => columnOf(t.status) === over.column && inLaneScope(t)));
  const activeIdx = fullSeq.findIndex((t) => t.id === activeId);
  const seq = fullSeq.filter((t) => t.id !== activeId);

  if (over.type === 'column') {
    const last = seq[seq.length - 1];
    if (!last) return { column: over.column, groupId: over.groupId };
    return { column: over.column, groupId: over.groupId, afterTaskId: last.id };
  }

  const overFullIdx = fullSeq.findIndex((t) => t.id === over.taskId);
  const overIdx = seq.findIndex((t) => t.id === over.taskId);
  if (overFullIdx < 0 || overIdx < 0) return null;
  const dropBelow = activeIdx >= 0 && activeIdx < overFullIdx;
  const before = dropBelow ? seq[overIdx] : seq[overIdx - 1];
  const after = dropBelow ? seq[overIdx + 1] : seq[overIdx];
  const resolution: DropResolution = { column: over.column, groupId: over.groupId };
  if (before) resolution.beforeTaskId = before.id;
  if (after) resolution.afterTaskId = after.id;
  return resolution;
}

// ── dnd over.id 解析纯函数 ────────────────────────────────────────────────────

interface DropLaneContext {
  groupId: string | null;
  laneIds: Set<string>;
}

interface DropColumnContext extends DropLaneContext {
  column: BoardColumnKey;
}

/** 泳道渲染落点注册表：列容器 droppable id 与任务 id → 泳道/列上下文 */
export interface DropIndex {
  columns: Map<string, DropColumnContext>;
  taskLane: Map<string, DropLaneContext & { task: TaskRow }>;
}

/**
 * 从泳道切分结果构建落点注册表。列容器 droppable id 规约：
 * `col:{laneKey}:{columnKey}`，laneKey=组 id / 'ungrouped'（未分组道）/ 'flat'（平铺单道）。
 */
export function buildDropIndex(lanes: BoardLane[], laneMode: 'flat' | 'lanes'): DropIndex {
  const columns = new Map<string, DropColumnContext>();
  const taskLane = new Map<string, DropLaneContext & { task: TaskRow }>();
  for (const lane of lanes) {
    const laneKey = laneMode === 'flat' ? 'flat' : (lane.group?.id ?? 'ungrouped');
    const groupId = lane.group?.id ?? null;
    const laneIds = new Set(lane.tasks.map((t) => t.id));
    for (const col of BOARD_COLUMNS) {
      columns.set(`col:${laneKey}:${col.key}`, { column: col.key, groupId, laneIds });
    }
    for (const task of lane.tasks) taskLane.set(task.id, { groupId, laneIds, task });
  }
  return { columns, taskLane };
}

/** 组装完成的落点目标：over 语义 + 可见序裁剪集 */
export interface BuiltDropTarget {
  over: DropOverTarget;
  /** 泳道模式=落点泳道成员集；平铺模式省略（整列可见序） */
  laneTaskIds?: Set<string>;
}

/**
 * dnd over.id → DropOverTarget 组装（纯函数）：
 *   - `col:` 前缀 → 列容器目标；其余视为任务 id → 卡片目标（columnOf(status) 定列）
 *   - 平铺模式：groupId 一律取 active 现组（纯排序不换组）、laneTaskIds 省略
 *   - 未注册 id（列容器不存在 / 任务不在板上）→ null
 */
export function buildDropTarget(
  overId: string,
  activeTask: TaskRow,
  index: DropIndex,
  laneMode: 'flat' | 'lanes',
): BuiltDropTarget | null {
  if (overId.startsWith('col:')) {
    const entry = index.columns.get(overId);
    if (!entry) return null;
    const groupId = laneMode === 'flat' ? activeTask.groupId : entry.groupId;
    const base: BuiltDropTarget = { over: { type: 'column', column: entry.column, groupId } };
    return laneMode === 'lanes' ? { ...base, laneTaskIds: entry.laneIds } : base;
  }
  const entry = index.taskLane.get(overId);
  if (!entry) return null;
  const groupId = laneMode === 'flat' ? activeTask.groupId : entry.groupId;
  const base: BuiltDropTarget = {
    over: { type: 'card', taskId: overId, column: columnOf(entry.task.status), groupId },
  };
  return laneMode === 'lanes' ? { ...base, laneTaskIds: entry.laneIds } : base;
}

// ── 可排序卡片包装（原位虚线洞）──────────────────────────────────────────────

interface SortableBoardCardProps {
  task: TaskRow;
  selected: boolean;
  onSelect: (id: string) => void;
  groupChip: BoardGroupChip | null;
}

/**
 * BoardCard 的 sortable 包装：外层 div 承载 dnd 属性/变换（BoardCard 是纯展示
 * button 不接注入）；拖拽中原位卡 invisible 保高（防塌陷）+ 虚线洞叠层。
 */
function SortableBoardCard({ task, selected, onSelect, groupChip }: SortableBoardCardProps): ReactNode {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="relative touch-none">
      <div className={isDragging ? 'invisible' : undefined}>
        <BoardCard task={task} selected={selected} onClick={() => onSelect(task.id)} groupChip={groupChip} />
      </div>
      {isDragging && (
        <div aria-hidden className="absolute inset-0 rounded-md border border-dashed border-strong" />
      )}
    </div>
  );
}

// ── 画板组件 ─────────────────────────────────────────────────────────────────

interface BoardCanvasProps {
  /** 可见任务（调用方已完成搜索/指派人过滤） */
  tasks: TaskRow[];
  groups: GroupRow[];
  laneMode: 'flat' | 'lanes';
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** 多容器碰撞策略（@dnd-kit 官方多列配方）：指针命中优先，无命中回退矩形相交 */
const collisionDetectionStrategy: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) return pointerCollisions;
  return rectIntersection(args);
};

export function BoardCanvas({ tasks, groups, laneMode, selectedId, onSelect }: BoardCanvasProps) {
  const move = useTaskStore((s) => s.move);
  const setDragging = useTaskStore((s) => s.setDragging);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // 拖拽刚结束标志：pointerup 后浏览器仍会派发 click 到源卡（pointer capture），
  // capture 阶段拦截防止「拖完一张卡误开详情抽屉」
  const suppressClickRef = useRef(false);

  const lanes = useMemo(() => splitLanes(tasks, groups, laneMode), [tasks, groups, laneMode]);
  const dropIndex = useMemo(() => buildDropIndex(lanes, laneMode), [lanes, laneMode]);
  const chipByGroup = useMemo(() => {
    const map = new Map<string, BoardGroupChip>();
    for (const g of groups) map.set(g.id, { name: g.name, color: g.color });
    return map;
  }, [groups]);

  const activeTask = activeDragId !== null ? (tasks.find((t) => t.id === activeDragId) ?? null) : null;
  const activeDragStatus = activeTask?.status ?? null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE_PX } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = (event: DragStartEvent): void => {
    setActiveDragId(String(event.active.id));
    setDragging(true);
  };

  const clearDrag = (): void => {
    setActiveDragId(null);
    setDragging(false);
    suppressClickRef.current = true;
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    clearDrag();
    if (!over) return;
    const activeId = String(active.id);
    const activeRow = tasks.find((t) => t.id === activeId);
    if (!activeRow) return;
    const built = buildDropTarget(String(over.id), activeRow, dropIndex, laneMode);
    if (!built) return;
    const resolution = resolveDrop(activeId, built.over, { tasks, laneTaskIds: built.laneTaskIds });
    if (!resolution) return;
    void move(activeId, resolution).catch((err: unknown) => {
      // toast 文案 Task 13 统一接入；先 console.error 保底可观测
      console.error('看板拖拽 move 失败', err);
    });
  };

  const renderCard = useCallback(
    (task: TaskRow): ReactNode => (
      <SortableBoardCard
        key={task.id}
        task={task}
        selected={task.id === selectedId}
        onSelect={onSelect}
        groupChip={
          laneMode === 'flat' && task.groupId !== null ? (chipByGroup.get(task.groupId) ?? null) : null
        }
      />
    ),
    [selectedId, onSelect, laneMode, chipByGroup],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetectionStrategy}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={clearDrag}
    >
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
        onPointerDownCapture={() => {
          suppressClickRef.current = false;
        }}
        onClickCapture={(e) => {
          if (suppressClickRef.current) {
            e.preventDefault();
            e.stopPropagation();
            suppressClickRef.current = false;
          }
        }}
      >
        {lanes.map((lane) => (
          <Lane
            key={lane.group?.id ?? 'lane-ungrouped'}
            lane={lane}
            laneMode={laneMode}
            renderCard={renderCard}
            activeDragStatus={activeDragStatus}
          />
        ))}
      </div>
      <DragOverlay>
        {activeTask && (
          <div className="w-[216px] rotate-2 cursor-grabbing shadow-2xl">
            <BoardCard
              task={activeTask}
              selected={false}
              onClick={() => undefined}
              groupChip={
                laneMode === 'flat' && activeTask.groupId !== null
                  ? (chipByGroup.get(activeTask.groupId) ?? null)
                  : null
              }
            />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
