// renderer/src/stores/task.store.ts
//
// 任务状态管理（B 子系统）:
//   - tasks：当前 workspace 内的任务列表（# 菜单 / 看板消费）
//   - load：拉取 workspace 任务列表（仅 pending 态：draft/pending/assigned，用于 # 菜单）
//   - create / update / transition：包装 ipc.task.*，成功后同步更新本地 tasks
//
// zustand 单例 store；workspace 切换时由布局层调 reset() 清空再 load(nextWorkspaceId)。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { TaskRow, TaskStatus } from '../ipc/types';

/** # 菜单只展示未完结任务（draft/pending/assigned） */
const PENDING_STATUSES: TaskStatus[] = ['draft', 'pending', 'assigned'];

interface TaskState {
  tasks: TaskRow[];
  loading: boolean;
  error: string | null;

  load: (workspaceId: string) => Promise<void>;
  create: (input: Parameters<typeof ipc.task.create>[0]) => Promise<TaskRow>;
  update: (id: string, patch: Partial<Omit<TaskRow, 'id' | 'createdAt'>>) => Promise<void>;
  transition: (
    id: string,
    to: TaskStatus,
    extraPatch?: Partial<Omit<TaskRow, 'id' | 'createdAt'>>,
  ) => Promise<void>;
  reset: () => void;
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  loading: false,
  error: null,

  load: async (workspaceId) => {
    set({ loading: true, error: null });
    try {
      const tasks = await ipc.task.list({ workspaceId, status: PENDING_STATUSES });
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

  reset: () => set({ tasks: [], loading: false, error: null }),
}));
