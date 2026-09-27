// renderer/src/stores/task.store.ts
//
// 任务状态管理（B 子系统）:
//   - tasks：当前 workspace 内的任务列表（# 菜单 / 看板消费）
//   - load：全生命周期拉取（v2.3 P0 修复，spec §8.1）——不按状态过滤，
//     orderBy created_at_desc + limit 500 截断终态历史（保留最新 500 条：
//     ASC + limit 会保留最旧 500 条、隐藏第 501 条之后的新任务）；
//     看板 'all' 筛选（TaskSidebarPanel ACTIVE_STATUSES）与 # 菜单
//     （MentionInput 本地 MENU_STATUSES）各自过滤，职责分层
//   - create / update / transition：包装 ipc.task.*，成功后同步更新本地 tasks
//   - move / archive / unarchive / setDragging（看板重构 Task 10）：
//     move 乐观更新 + 行级回滚；pendingMoveCount/dragging 让 load 在
//     在途乐观 / 拖拽手持期间跳过（防 5s 轮询覆盖，Review Focus ④）
//
// zustand 单例 store；workspace 切换时由布局层调 reset() 清空再 load(nextWorkspaceId)。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { BoardColumnKey } from '../ipc/board-columns';
import type { TaskRow, TaskStatus } from '../ipc/types';

/**
 * 乐观状态映射（看板重构 Task 10）：目标列 → 列代表状态。
 * backlog 不在表内——backlog 列只做排序/换泳道，不隐含状态转换
 * （draft/pending 已是该列状态；主进程 move 仍是权威裁决）。
 */
const OPTIMISTIC_STATUS: Partial<Record<BoardColumnKey, TaskStatus>> = {
  assigned: 'assigned',
  active: 'in_progress',
  done: 'completed',
  closed: 'cancelled',
};

interface TaskState {
  tasks: TaskRow[];
  loading: boolean;
  error: string | null;
  /** 看板选中任务（P2 Task 3 从 TaskBoardView 本地 state 提升：侧边栏写、主区读） */
  selectedTaskId: string | null;
  setSelectedTaskId: (id: string | null) => void;
  /** 当前 tasks 所属的 workspace ID；load 切换 workspace 时据此重置选中态与列表 */
  currentWorkspaceId: string | null;
  /** 在途乐观 move 计数：>0 时 load 跳过（防轮询覆盖在途乐观态） */
  pendingMoveCount: number;
  /** 拖拽手持中：load 跳过（防轮询刷新导致列表跳动打断拖拽） */
  dragging: boolean;
  setDragging: (dragging: boolean) => void;

  load: (workspaceId: string) => Promise<void>;
  create: (input: Parameters<typeof ipc.task.create>[0]) => Promise<TaskRow>;
  update: (id: string, patch: Partial<Omit<TaskRow, 'id' | 'createdAt'>>) => Promise<void>;
  transition: (
    id: string,
    to: TaskStatus,
    extraPatch?: Partial<Omit<TaskRow, 'id' | 'createdAt'>>,
  ) => Promise<void>;
  /**
   * 拖拽落点单一通道（看板重构 Task 6/10）：本地先乐观变（列代表状态 +
   * groupId），IPC 成功用返回行覆盖，失败回滚目标行并 rethrow（上层 toast）。
   */
  move: (id: string, target: Parameters<typeof ipc.task.move>[1]) => Promise<void>;
  /** 归档：成功即本地剔除（load 默认排除归档行，与之对齐）；失败 rethrow 本地不动 */
  archive: (id: string) => Promise<void>;
  /** 解档：成功即把返回行塞回 tasks */
  unarchive: (id: string) => Promise<void>;
  reset: () => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  loading: false,
  error: null,
  selectedTaskId: null,
  currentWorkspaceId: null,
  pendingMoveCount: 0,
  dragging: false,
  setSelectedTaskId: (id) => set({ selectedTaskId: id }),
  setDragging: (dragging) => set({ dragging }),

  load: async (workspaceId) => {
    // 在途乐观 move / 拖拽手持中跳过本轮（Review Focus ④：
    // 5s 轮询会用在途乐观态之前的服务端快照覆盖本地，造成卡片跳回）
    if (get().pendingMoveCount > 0 || get().dragging) return;
    // workspace 切换时重置选中态与列表（看板隔离）：TaskDetailPanel 按 taskId
    // 直查 ipc.task.get，旧 ws 的选中残留会把旧任务详情顶进新 ws 看板
    if (get().currentWorkspaceId !== workspaceId) {
      set({ currentWorkspaceId: workspaceId, selectedTaskId: null, tasks: [] });
    }
    set({ loading: true, error: null });
    try {
      // v2.3：全生命周期拉取（spec §8.1）——单用户桌面端任务量级下
      // 全量 + 本地过滤足够；终态历史靠 limit 500 截断（保留最新 500 条）
      const tasks = await ipc.task.list({ workspaceId, orderBy: 'created_at_desc', limit: 500 });
      set({ tasks, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  create: async (input) => {
    const created = await ipc.task.create(input);
    set((s) => ({ tasks: [...s.tasks, created] }));
    return created;
  },

  update: async (id, patch) => {
    await ipc.task.update(id, patch);
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  },

  transition: async (id, to, extraPatch) => {
    const updated = await ipc.task.transition(id, to, extraPatch);
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? updated : t)) }));
  },

  move: async (id, target) => {
    // 行级快照：失败时只回滚目标行（非整表快照——并发在途的其他 move
    // 成功行不被踩踏；若期间列表已被 reset/切换，id 不匹配自然 no-op）
    const snapshotRow = get().tasks.find((t) => t.id === id) ?? null;
    set((s) => ({
      pendingMoveCount: s.pendingMoveCount + 1,
      tasks: s.tasks.map((t) =>
        t.id === id
          ? { ...t, groupId: target.groupId, status: OPTIMISTIC_STATUS[target.column] ?? t.status }
          : t,
      ),
    }));
    try {
      const updated = await ipc.task.move(id, target);
      // 权威行覆盖：服务端状态机裁决 + updatedAt 等服务端字段生效
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? updated : t)) }));
    } catch (err) {
      if (snapshotRow) {
        set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? snapshotRow : t)) }));
      }
      throw err; // 上层 toast
    } finally {
      // Math.max 防 reset 交错产生负计数（reset 清零后本 move 的 finally 再减）
      set((s) => ({ pendingMoveCount: Math.max(0, s.pendingMoveCount - 1) }));
    }
  },

  archive: async (id) => {
    await ipc.task.archive(id); // 非终态 reject → 本地不动，错误上抛
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
  },

  unarchive: async (id) => {
    const restored = await ipc.task.unarchive(id);
    set((s) => ({ tasks: [...s.tasks, restored] }));
  },

  reset: () =>
    set({
      tasks: [],
      loading: false,
      error: null,
      selectedTaskId: null,
      currentWorkspaceId: null,
      pendingMoveCount: 0,
      dragging: false,
    }),
}));
