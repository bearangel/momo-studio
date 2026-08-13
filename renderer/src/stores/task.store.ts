// renderer/src/stores/task.store.ts
//
// 任务状态管理（B 子系统）:
//   - tasks：当前 workspace 内的任务列表（status in draft/pending/assigned 用于 # 菜单）
//   - 加载/清理入口：loadTasks（IPC 接入留待 B6/B7 chat loop 改造）、reset
//
// 现阶段 store 只承载数据 + 占位 loadTasks，IPC 通道（task:list / task:create / task:update）
// 由 B 后续任务在 main process 暴露后接入；MentionInput 当前只读 `tasks` 字段。
import { create } from 'zustand';
import type { TaskRow } from '../ipc/types';

interface TaskState {
  tasks: TaskRow[];
  loading: boolean;
  error: string | null;

  /** 占位 action：实际 IPC 接入留待后续 task。当前实现只把入参写入 store。 */
  loadTasks: (workspaceId: string) => Promise<void>;
  reset: () => void;
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  loading: false,
  error: null,

  loadTasks: async (_workspaceId: string) => {
    // B6/B7 在 main process 暴露 task:list IPC 后，这里调用 ipc.task.list(workspaceId)
    // 并 set({ tasks, loading: false })。当前保持空实现以不阻塞 UI 组件联调。
    set({ loading: false });
  },

  reset: () => set({ tasks: [], loading: false, error: null }),
}));
