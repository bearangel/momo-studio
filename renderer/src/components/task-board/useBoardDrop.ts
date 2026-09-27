// renderer/src/components/task-board/useBoardDrop.ts
//
// 看板拖拽落点协调 hook(看板重构 Task 13):
//   - 拖拽生命周期:dragStart(轮询守卫 setDragging)/ dragOver(拖悬指示线)/
//     dragEnd / dragCancel,入参一律原始 id——不依赖 dnd 事件形状,组件层只做
//     事件适配,jsdom 下可经 renderHook 直驱组装链(Task 12 裁定的延续)
//   - 落点组装链全真实:buildDropTarget → resolveDrop → task.store.move
//     (乐观 + 回滚内置);requireConfirm 拦截 → pendingConfirm,确认才 move,
//     取消零调用(乐观更新尚未发生,卡片天然在原位)
//   - move 失败 → ui/Toast 直出主进程中文原因(message 直出,主进程已保证文案)
//   - wire 契约:requireConfirm 是 UI 决策字段,经 toMoveTarget 剥离,
//     绝不泄入主进程 MoveTarget(momo-boundary-rules)
import { useCallback, useState } from 'react';
import { ipc } from '../../ipc/client';
import type { BoardColumnKey } from '../../ipc/board-columns';
import type { TaskRow } from '../../ipc/types';
import { useTaskStore } from '../../stores/task.store';
import { showToast } from '../ui/Toast';
import { buildDropTarget, resolveDrop, type DropIndex, type DropResolution } from './BoardCanvas';

/** 主进程 wire 契约类型(task.move 的 target;不含 requireConfirm) */
type TaskMoveTarget = Parameters<typeof ipc.task.move>[1];

/** 待确认落点:taskId + 落点决议(requireConfirm=true 的拦截产物) */
export interface PendingDropConfirm {
  taskId: string;
  resolution: DropResolution;
}

/** 拖悬插入指示线:beforeTaskId=线画该卡上方 / afterTaskId=线画该卡下方 / tailOf=空列尾线 */
export interface DropHint {
  beforeTaskId?: string;
  afterTaskId?: string;
  tailOf: string | null;
}

/** 确认弹窗文案(spec 裁定语义如实描述:done 不停 agent,closed 终止) */
export function dropConfirmContent(column: BoardColumnKey): {
  title: string;
  message: string;
  confirmLabel: string;
} {
  if (column === 'done') {
    return {
      title: '确认手动完成任务',
      message: 'agent 可能仍在运行。确认后任务将转为已完成,但 agent 运行不会停止。',
      confirmLabel: '完成任务',
    };
  }
  if (column === 'closed') {
    return {
      title: '确认取消运行中任务',
      message: '确认取消该运行中任务?此操作将终止 agent 运行。',
      confirmLabel: '终止运行',
    };
  }
  // 防御:只有 done/closed 会进确认流(requireConfirm 判定单源在 resolveDrop)
  throw new Error(`该列无需二次确认: ${column}`);
}

/** 落点决议 → wire target(requireConfirm 剥离,显式构造防字段漂移) */
function toMoveTarget(resolution: DropResolution): TaskMoveTarget {
  const target: TaskMoveTarget = { column: resolution.column, groupId: resolution.groupId };
  if (resolution.beforeTaskId !== undefined) target.beforeTaskId = resolution.beforeTaskId;
  if (resolution.afterTaskId !== undefined) target.afterTaskId = resolution.afterTaskId;
  return target;
}

export function useBoardDrop(opts: { tasks: TaskRow[]; laneMode: 'flat' | 'lanes'; dropIndex: DropIndex }): {
  activeDragId: string | null;
  dragStart: (taskId: string) => void;
  dragOver: (taskId: string, overId: string | null) => void;
  dragEnd: (taskId: string, overId: string | null) => void;
  dragCancel: () => void;
  pendingConfirm: PendingDropConfirm | null;
  confirmMove: () => void;
  cancelConfirm: () => void;
  dropHint: DropHint | null;
} {
  const { tasks, laneMode, dropIndex } = opts;
  const move = useTaskStore((s) => s.move);
  const setDragging = useTaskStore((s) => s.setDragging);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingDropConfirm | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);

  const performMove = useCallback(
    async (taskId: string, resolution: DropResolution): Promise<void> => {
      try {
        await move(taskId, toMoveTarget(resolution));
      } catch (err) {
        // 主进程拒绝消息已保证中文文案(dropRejectReason 等),直出不改写
        showToast((err as Error).message);
      }
    },
    [move],
  );

  const dragStart = useCallback(
    (taskId: string): void => {
      setActiveDragId(taskId);
      setDragging(true);
    },
    [setDragging],
  );

  const clearDrag = useCallback((): void => {
    setActiveDragId(null);
    setDragging(false);
    setDropHint(null);
  }, [setDragging]);

  /** 组装链共享段:overId → 落点决议;非法/禁投/自身 → null */
  const resolveOver = useCallback(
    (taskId: string, overId: string): DropResolution | null => {
      const activeRow = tasks.find((t) => t.id === taskId);
      if (!activeRow) return null;
      const built = buildDropTarget(overId, activeRow, dropIndex, laneMode);
      if (!built) return null;
      return resolveDrop(taskId, built.over, { tasks, laneTaskIds: built.laneTaskIds });
    },
    [tasks, dropIndex, laneMode],
  );

  const dragOver = useCallback(
    (taskId: string, overId: string | null): void => {
      if (overId === null) {
        setDropHint(null);
        return;
      }
      const resolution = resolveOver(taskId, overId);
      if (resolution === null) {
        // 禁投列/自身原位:不画线(禁投视觉由列级 opacity 表达)
        setDropHint(null);
        return;
      }
      const next: DropHint = {
        beforeTaskId: resolution.beforeTaskId,
        afterTaskId: resolution.afterTaskId,
        tailOf:
          resolution.beforeTaskId === undefined && resolution.afterTaskId === undefined
            ? overId // 无锚 ⇒ 空列容器,overId 即列 droppableId
            : null,
      };
      // 引用稳定比较:onDragOver 高频触发,同槽位不重建对象防无谓重渲染
      setDropHint((prev) =>
        prev !== null && prev.beforeTaskId === next.beforeTaskId && prev.afterTaskId === next.afterTaskId && prev.tailOf === next.tailOf
          ? prev
          : next,
      );
    },
    [resolveOver],
  );

  const dragEnd = useCallback(
    (taskId: string, overId: string | null): void => {
      clearDrag();
      if (overId === null) return;
      const resolution = resolveOver(taskId, overId);
      if (resolution === null) return;
      if (resolution.requireConfirm) {
        // 先弹确认:move 不发、乐观更新不发生——取消即零副作用归位
        setPendingConfirm({ taskId, resolution });
        return;
      }
      void performMove(taskId, resolution);
    },
    [clearDrag, resolveOver, performMove],
  );

  const dragCancel = useCallback((): void => {
    clearDrag();
  }, [clearDrag]);

  const confirmMove = useCallback((): void => {
    const pending = pendingConfirm;
    setPendingConfirm(null);
    if (pending) void performMove(pending.taskId, pending.resolution);
  }, [pendingConfirm, performMove]);

  const cancelConfirm = useCallback((): void => {
    setPendingConfirm(null);
  }, []);

  return {
    activeDragId,
    dragStart,
    dragOver,
    dragEnd,
    dragCancel,
    pendingConfirm,
    confirmMove,
    cancelConfirm,
    dropHint,
  };
}
