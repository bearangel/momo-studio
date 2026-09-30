// renderer/src/components/task-board/BoardCanvas.tsx
//
// 看板画板拖拽编排（看板重构 Task 12，spec §4/§5.1/§6）：
//   - DndContext（PointerSensor 距离激活 + KeyboardSensor 方向键排序）包裹整个板，
//     Lane × N 泳道渲染（泳道模式 splitLanes 切道；平铺模式单道）
//   - DragOverlay：微倾跟手卡片；原位 sortable 卡变虚线洞（Lane 内 SortableBoardCard）
//   - onDragStart → 轮询守卫 setDragging;onDragEnd/onDragOver → useBoardDrop
//     (Task 13 收敛):resolveDrop 裁决 → requireConfirm(in_progress→done/closed)
//     先弹 ui/ConfirmDialog(取消零调用)/ 否则 task.store.move(乐观+回滚),
//     move 失败 → ui/Toast 直出主进程中文原因;onDragOver → 拖悬指示线
//     (禁投列变暗标注 / 合法列 accent 虚线 / 插入槽 2px 线,渲染在 BoardColumn)
//
// 拖拽三分支语义(spec §4 裁决表)：同列同泳道=纯排序（before/after 邻居透传）、
// 同列跨泳道=换组、跨列=column 变化；renderer 只发落点，动作裁决单点在主进程
// executeMove。
//
// 纯函数出口（单测主战场，BoardCanvas.test.tsx）：
//   - resolveDrop：落点裁决（禁投预判 canDropIntoColumn 单源 → null）
//   - buildDropIndex / buildDropTarget：dnd over.id → 落点目标组装
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react';
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
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useSortable } from '@dnd-kit/sortable';
import { BOARD_COLUMNS, canDropIntoColumn, columnOf, type BoardColumnKey } from '../../ipc/board-columns';
import { groupChipColor, splitLanes, type BoardLane } from '../../lib/board';
import type { GroupRow, TaskRow } from '../../ipc/types';
import { useTaskStore } from '../../stores/task.store';
import { BoardCard, type BoardGroupChip } from './BoardCard';
import { Lane } from './Lane';
import { useBoardDrop, dropConfirmContent } from './useBoardDrop';
import { AssignTargetDialog } from './AssignTargetDialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Toast } from '../ui/Toast';

/** PointerSensor 激活位移阈值（px）：小于该位移视为点击（选中卡片），不启动拖拽 */
const DRAG_ACTIVATION_DISTANCE_PX = 5;

// ── 落点裁决纯函数 ────────────────────────────────────────────────────────────

/**
 * dnd over 目标：落卡片（带 taskId）或列容器（空列/列尾落点）
 */
export type DropOverTarget =
  | { type: 'card'; taskId: string; column: BoardColumnKey; groupId: string | null }
  | { type: 'column'; column: BoardColumnKey; groupId: string | null };

/**
 * over.groupId 语义：目标组。泳道模式=落点泳道的组（未分组道 null，跨泳道拖=换组）；
 * 平铺模式由调用方传 active 任务现组——单道无组语义，同列即 no-op。
 */
export interface DropCtx {
  tasks: TaskRow[];
}

/** 落点决议:requireConfirm 之外的字段与 ipc.task.move 的 target 契约对齐 */
export interface DropResolution {
  column: BoardColumnKey;
  groupId: string | null;
  /**
   * in_progress → done/closed 松手需二次确认(Task 13:agent 可能仍在运行)。
   * UI 决策字段——useBoardDrop.toMoveTarget 剥离后才发 wire,
   * 不进主进程 MoveTarget 契约(momo-boundary-rules)。
   */
  requireConfirm: boolean;
}

/**
 * 拖拽落点裁决（纯函数，2026-09-30 排序退役后简化）：
 *   - active 不在 ctx.tasks / 目标列禁投（canDropIntoColumn 单源）/ over 卡=自身 → null
 *   - 同列同组 → null（列内顺序由 pinned/创建时间决定，拖拽无排序语义）
 *   - 其余（跨列状态流转 / 同列跨泳道换组）→ { column, groupId }（无卡级锚点）
 */
export function resolveDrop(activeId: string, over: DropOverTarget, ctx: DropCtx): DropResolution | null {
  const activeTask = ctx.tasks.find((t) => t.id === activeId);
  if (!activeTask) return null;
  if (!canDropIntoColumn(activeTask.status, over.column)) return null;
  if (over.type === 'card' && over.taskId === activeId) return null;

  if (columnOf(activeTask.status) === over.column && activeTask.groupId === over.groupId) {
    return null;
  }

  // 确认拦截(Task 13):运行中任务移终态列(done/closed)松手先弹确认——
  // done 不停 agent、closed 终止,语义需用户二次拍板(spec §4 裁定)
  const requireConfirm =
    activeTask.status === 'in_progress' && (over.column === 'done' || over.column === 'closed');
  return { column: over.column, groupId: over.groupId, requireConfirm };
}

// ── dnd over.id 解析纯函数 ────────────────────────────────────────────────────

interface DropLaneContext {
  groupId: string | null;
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
    for (const col of BOARD_COLUMNS) {
      columns.set(`col:${laneKey}:${col.key}`, { column: col.key, groupId });
    }
    for (const task of lane.tasks) taskLane.set(task.id, { groupId, task });
  }
  return { columns, taskLane };
}

/** dnd over.id → DropOverTarget 组装（纯函数）：
 *   - `col:` 前缀 → 列容器目标；其余视为任务 id → 卡片目标（columnOf(status) 定列）
 *   - 平铺模式：groupId 一律取 active 现组（单道无换组语义，同列即 no-op）
 *   - 未注册 id（列容器不存在 / 任务不在板上）→ null
 */
export function buildDropTarget(
  overId: string,
  activeTask: TaskRow,
  index: DropIndex,
  laneMode: 'flat' | 'lanes',
): DropOverTarget | null {
  if (overId.startsWith('col:')) {
    const entry = index.columns.get(overId);
    if (!entry) return null;
    const groupId = laneMode === 'flat' ? activeTask.groupId : entry.groupId;
    return { type: 'column', column: entry.column, groupId };
  }
  const entry = index.taskLane.get(overId);
  if (!entry) return null;
  const groupId = laneMode === 'flat' ? activeTask.groupId : entry.groupId;
  return { type: 'card', taskId: overId, column: columnOf(entry.task.status), groupId };
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
  /** 指派弹框（§4.4 无目标 draft 拖入排队中）拉目标列表用 */
  workspaceId: string;
}

/** 多容器碰撞策略（@dnd-kit 官方多列配方）：指针命中优先，无命中回退矩形相交 */
const collisionDetectionStrategy: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) return pointerCollisions;
  return rectIntersection(args);
};

export function BoardCanvas({ tasks, groups, laneMode, selectedId, onSelect, workspaceId }: BoardCanvasProps) {
  const setDragging = useTaskStore((s) => s.setDragging);
  // 拖拽刚结束标志：pointerup 后浏览器仍会派发 click 到源卡（pointer capture），
  // capture 阶段拦截防止「拖完一张卡误开详情抽屉」
  const suppressClickRef = useRef(false);

  const lanes = useMemo(() => splitLanes(tasks, groups, laneMode), [tasks, groups, laneMode]);
  const dropIndex = useMemo(() => buildDropIndex(lanes, laneMode), [lanes, laneMode]);
  // 落点协调(Task 13 收敛到 hook):确认拦截/move/toast/指示线;
  // 组件只做 dnd 事件 → 原始 id 的适配
  const drop = useBoardDrop({ tasks, laneMode, dropIndex });
  // 组 chip 组装（UX 波 2 #7）：组色在此单点解析成 fg/bg 配色串传入 BoardCard，
  // 卡片与 DragOverlay 免重复解析；未知/无色 → null/null（卡片回退中性样式）
  const chipByGroup = useMemo(() => {
    const map = new Map<string, BoardGroupChip>();
    for (const g of groups) {
      const chip = groupChipColor(g.color);
      map.set(g.id, {
        name: g.name,
        color: g.color,
        fg: chip?.fg ?? null,
        bg: chip?.bg ?? null,
      });
    }
    return map;
  }, [groups]);

  const activeTask = drop.activeDragId !== null ? (tasks.find((t) => t.id === drop.activeDragId) ?? null) : null;
  const activeDragStatus = activeTask?.status ?? null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE_PX } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // unmount 兜底：拖拽手持中切走视图（workspace 切换卸载画板）时复位轮询守卫，
  // 防 dragging=true 永久卡住后续 load
  useEffect(() => {
    return () => {
      setDragging(false);
    };
  }, [setDragging]);

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
      onDragStart={(event) => drop.dragStart(String(event.active.id))}
      onDragOver={(event) => drop.dragOver(String(event.active.id), event.over ? String(event.over.id) : null)}
      onDragEnd={(event) => {
        // 松手即拦截后续 click(pointer capture 复用源卡),防误开详情抽屉
        suppressClickRef.current = true;
        drop.dragEnd(String(event.active.id), event.over ? String(event.over.id) : null);
      }}
      onDragCancel={() => {
        suppressClickRef.current = true;
        drop.dragCancel();
      }}
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
            dropHint={drop.dropHint}
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
      {/* in_progress → done/closed 确认框(Task 13):取消零调用卡片归位、确认才 move */}
      {drop.pendingConfirm !== null && (
        <ConfirmDialog
          {...dropConfirmContent(drop.pendingConfirm.resolution.column)}
          onConfirm={drop.confirmMove}
          onClose={drop.cancelConfirm}
        />
      )}
      {/* §4.4 无目标 draft 拖入排队中 → 指派弹框(取消零副作用归位) */}
      {drop.pendingAssign !== null && (
        <AssignTargetDialog
          open
          taskId={drop.pendingAssign.taskId}
          groupId={drop.pendingAssign.groupId}
          workspaceId={workspaceId}
          onCancel={drop.cancelAssign}
        />
      )}
      {/* move 失败 toast:文案由主进程中文消息直出 */}
      <Toast />
    </DndContext>
  );
}
