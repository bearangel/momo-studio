// renderer/src/components/task-board/useGroupActions.ts
//
// 分组操作公共 hook（看板重构 Task 14）：重命名/换色/归档组/取消归档的
// store 调用 + 失败 toast + 归档确认态，供 GroupManageList（侧边栏列表）与
// GroupMenu（Lane 泳道头 / 列表行共用菜单）两处消费同一逻辑。
//
// 归档语义（Task 7/10 契约）：
//   - groupStore.archive 主进程单事务级联（组内非终态 cancel + 全组归档）；
//     成功后必须调 taskStore.load 刷新任务列表（级联归档改变了 task:list
//     可见性——group.store 不跨 store 联动，UI 层承接）
//   - 确认文案的 N = 组内未完结任务数（终态不计），从 task.store.tasks 实时算
import { useCallback, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { showToast } from '../ui/Toast';
import { useGroupStore } from '../../stores/group.store';
import { useTaskStore } from '../../stores/task.store';
import type { GroupRow, TaskStatus } from '../../ipc/types';

/** 色板固定 5 语义色（与 lib/board.ts GROUP_COLOR_VARS 键集同源，Task 14 契约） */
export const GROUP_PALETTE = ['accent', 'violet', 'success', 'warning', 'error'] as const;

/** 终态集合：归档组确认文案的 N 不计入终态任务 */
const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];

export interface GroupActions {
  /** 组内未完结任务数（归档确认文案的实时 N；终态不计） */
  openTaskCount: (groupId: string) => number;
  /** 重命名；失败 toast，返回是否成功 */
  runRename: (id: string, name: string) => Promise<boolean>;
  /** 换色；失败 toast，返回是否成功 */
  runSetColor: (id: string, color: string) => Promise<boolean>;
  /** 取消归档（只复活组本体，任务保持归档）；失败 toast */
  runUnarchive: (id: string) => Promise<void>;
  /** 请求归档组（打开确认框） */
  requestArchive: (group: GroupRow) => void;
  /** 归档确认框节点（pendingArchive 非空时渲染；消费方直接挂载） */
  archiveConfirm: ReactNode;
}

export function useGroupActions(workspaceId: string): GroupActions {
  const tasks = useTaskStore((s) => s.tasks);
  const rename = useGroupStore((s) => s.rename);
  const setColor = useGroupStore((s) => s.setColor);
  const archiveGroup = useGroupStore((s) => s.archive);
  const unarchiveGroup = useGroupStore((s) => s.unarchive);
  const loadTasks = useTaskStore((s) => s.load);
  const [pendingArchive, setPendingArchive] = useState<GroupRow | null>(null);

  const openTaskCount = useCallback(
    (groupId: string): number =>
      tasks.filter((t) => t.groupId === groupId && !TERMINAL_STATUSES.includes(t.status)).length,
    [tasks],
  );

  const runRename = useCallback(
    async (id: string, name: string): Promise<boolean> => {
      try {
        await rename(id, name);
        return true;
      } catch (err) {
        showToast(`重命名失败: ${(err as Error).message}`);
        return false;
      }
    },
    [rename],
  );

  const runSetColor = useCallback(
    async (id: string, color: string): Promise<boolean> => {
      try {
        await setColor(id, color);
        return true;
      } catch (err) {
        showToast(`换色失败: ${(err as Error).message}`);
        return false;
      }
    },
    [setColor],
  );

  const runUnarchive = useCallback(
    async (id: string): Promise<void> => {
      try {
        await unarchiveGroup(id);
      } catch (err) {
        showToast(`取消归档失败: ${(err as Error).message}`);
      }
    },
    [unarchiveGroup],
  );

  /** 确认归档：级联归档 + 任务列表刷新（Task 10 承接）；无论成败关确认框 */
  const confirmArchive = useCallback(
    async (group: GroupRow): Promise<void> => {
      try {
        await archiveGroup(group.id);
        await loadTasks(workspaceId);
      } catch (err) {
        showToast(`归档组失败: ${(err as Error).message}`);
      }
    },
    [archiveGroup, loadTasks, workspaceId],
  );

  const archiveConfirm: ReactNode =
    pendingArchive !== null ? (
      <ConfirmDialog
        title="归档分组"
        message={`组内还有 ${openTaskCount(pendingArchive.id)} 个未完结任务，将一并取消并归档`}
        confirmLabel="归档"
        onConfirm={() => {
          void confirmArchive(pendingArchive);
        }}
        onClose={() => setPendingArchive(null)}
      />
    ) : null;

  return {
    openTaskCount,
    runRename,
    runSetColor,
    runUnarchive,
    requestArchive: setPendingArchive,
    archiveConfirm,
  };
}
