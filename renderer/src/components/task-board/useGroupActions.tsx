// renderer/src/components/task-board/useGroupActions.ts
//
// 分组操作公共 hook（看板重构 Task 14）：重命名/换色/归档组/取消归档/删除组的
// store 调用 + 失败 toast + 归档/删除确认态，供 GroupManageList（侧边栏列表）与
// GroupMenu（Lane 泳道头 / 列表行共用菜单）两处消费同一逻辑。
//
// 归档语义（Task 7/10 契约）：
//   - groupStore.archive 主进程单事务级联（组内非终态 cancel + 全组归档）；
//     成功后必须调 taskStore.load 刷新任务列表（级联归档改变了 task:list
//     可见性——group.store 不跨 store 联动，UI 层承接）
//   - 确认文案的 N = 组内未完结任务数（终态不计），从 task.store.tasks 实时算
//
// 删除语义（删容器不删内容）：
//   - groupStore.delete 主进程单事务转移组内任务到目标组（默认未分组）后删组；
//     成功后照归档承接模式调 taskStore.load 刷新（任务归属变了）
//   - 确认框的 N = 组内当前可见任务数（全状态计——删除时全部转移；从
//     task.store.tasks 实时算，组内归档任务不在 store 中故不计入展示值）
import { useCallback, useState, type ReactNode } from 'react';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Dialog } from '../ui/Dialog';
import { Select } from '../ui/Select';
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
  /** 取消归档（主进程组+组内归档任务一并恢复，成功后刷新任务列表）；失败 toast */
  runUnarchive: (id: string) => Promise<void>;
  /** 请求归档组（打开确认框） */
  requestArchive: (group: GroupRow) => void;
  /** 归档确认框节点（pendingArchive 非空时渲染；消费方直接挂载） */
  archiveConfirm: ReactNode;
  /** 请求删除组（打开转移确认框） */
  requestDelete: (group: GroupRow) => void;
  /** 删除确认框节点（pendingDelete 非空时渲染；消费方直接挂载） */
  deleteConfirm: ReactNode;
}

export function useGroupActions(workspaceId: string): GroupActions {
  const tasks = useTaskStore((s) => s.tasks);
  const rename = useGroupStore((s) => s.rename);
  const setColor = useGroupStore((s) => s.setColor);
  const archiveGroup = useGroupStore((s) => s.archive);
  const unarchiveGroup = useGroupStore((s) => s.unarchive);
  const deleteGroup = useGroupStore((s) => s.delete);
  const loadTasks = useTaskStore((s) => s.load);
  /** 转移目标候选：当前 workspace 活跃组（确认框 Select 数据源） */
  const groups = useGroupStore((s) => s.groups);
  const [pendingArchive, setPendingArchive] = useState<GroupRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<GroupRow | null>(null);
  /** 删除转移目标：'' = 未分组（IPC null）；每次打开确认框重置回默认 */
  const [deleteMoveTo, setDeleteMoveTo] = useState('');

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
        // 解档连带恢复组内任务（主进程事务）→ 刷新任务列表（照 confirmArchive 承接模式）
        await loadTasks(workspaceId);
      } catch (err) {
        showToast(`取消归档失败: ${(err as Error).message}`);
      }
    },
    [unarchiveGroup, loadTasks, workspaceId],
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

  /** 确认删除：转移 + 任务列表刷新（照 confirmArchive 承接模式）；无论成败关确认框 */
  const confirmDelete = useCallback(
    async (group: GroupRow, moveToGroupId: string | null): Promise<void> => {
      try {
        await deleteGroup(group.id, moveToGroupId);
        await loadTasks(workspaceId);
      } catch (err) {
        showToast(`删除分组失败: ${(err as Error).message}`);
      }
    },
    [deleteGroup, loadTasks, workspaceId],
  );

  const deleteConfirm: ReactNode =
    pendingDelete !== null ? (
      <Dialog
        open
        onClose={() => setPendingDelete(null)}
        title={`删除分组「${pendingDelete.name}」`}
        width={360}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = pendingDelete;
                const moveTo = deleteMoveTo === '' ? null : deleteMoveTo;
                setPendingDelete(null);
                void confirmDelete(target, moveTo);
              }}
            >
              删除
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <div>
            组内 {tasks.filter((t) => t.groupId === pendingDelete.id).length} 个任务将转移到:
          </div>
          <Select
            aria-label="转移目标分组"
            value={deleteMoveTo}
            onChange={(e) => setDeleteMoveTo(e.target.value)}
          >
            <option value="">未分组</option>
            {groups
              .filter((g) => g.id !== pendingDelete.id)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </Select>
        </div>
      </Dialog>
    ) : null;

  return {
    openTaskCount,
    runRename,
    runSetColor,
    runUnarchive,
    requestArchive: setPendingArchive,
    archiveConfirm,
    requestDelete: (group) => {
      setDeleteMoveTo('');
      setPendingDelete(group);
    },
    deleteConfirm,
  };
}
