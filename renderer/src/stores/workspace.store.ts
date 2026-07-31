// renderer/src/stores/workspace.store.ts
// Workspace 状态管理：列表加载、创建、切换激活 workspace
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { Workspace, CreateWorkspaceInput } from '../ipc/types';

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  loading: boolean;
  error: string | null;

  // 拉取 workspace 列表，默认激活第一个
  load: () => Promise<void>;
  // 创建 workspace 并自动激活
  create: (input: CreateWorkspaceInput) => Promise<void>;
  // 切换激活的 workspace
  select: (id: string) => void;
  // 获取当前激活的 workspace（无则 null）
  getActive: () => Workspace | null;
  // 设为/取消协调 agent（instanceId=null 表示取消），完成后刷新 workspaces
  setCoordinator: (workspaceId: string, instanceId: string | null) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const list = await ipc.workspace.list();
      // 列表非空时默认激活第一个（noUncheckedIndexedAccess 下需非空断言）
      const activeId = list.length > 0 ? list[0]!.id : null;
      set({ workspaces: list, activeWorkspaceId: activeId, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  create: async (input) => {
    const ws = await ipc.workspace.create(input);
    // 新建的 workspace 插入到列表头部并设为激活
    set((state) => ({
      workspaces: [ws, ...state.workspaces],
      activeWorkspaceId: ws.id,
    }));
  },

  select: (id) => set({ activeWorkspaceId: id }),

  getActive: () => {
    const { workspaces, activeWorkspaceId } = get();
    return workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  },

  setCoordinator: async (workspaceId, instanceId) => {
    set({ error: null });
    try {
      await ipc.workspace.setCoordinator(workspaceId, instanceId);
      // 刷新 workspace 列表以拿到新的 coordinatorInstanceId
      const list = await ipc.workspace.list();
      set({ workspaces: list });
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },
}));
