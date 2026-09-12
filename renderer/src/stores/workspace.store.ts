// renderer/src/stores/workspace.store.ts
// Workspace 状态管理：列表加载、创建、切换激活 workspace。
// v2.7 T10：激活变化（load 默认项 / create 新建 / select 用户切换）经
// workspace:switch 通知 main（浏览器子系统视图生命周期收口）；通知失败静默——
// 通知是异步旁路，不阻塞本地激活状态。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { Workspace, CreateWorkspaceInput } from '../ipc/types';

/** 通知 main 激活切换（fire-and-forget；IPC 故障不影响本地状态） */
function notifySwitch(id: string | null): void {
  if (!id) return;
  void ipc.workspace.switch(id).catch(() => {});
}

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
  // 设为/取消默认会话 agent（instanceId=null 表示取消），完成后刷新 workspaces
  setDefaultAgent: (workspaceId: string, instanceId: string | null) => Promise<void>;
  // 删除 workspace 并刷新列表（删除激活项时由 load 回退到首个）；失败抛错给调用方提示
  remove: (id: string) => Promise<void>;
  // 重命名 workspace，成功后本地同步名称；失败抛错且本地名称不变
  rename: (id: string, name: string) => Promise<void>;
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
      notifySwitch(activeId); // 初始激活通知 main（boot 初始激活的 renderer 侧来源）
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
    notifySwitch(ws.id); // 新建即激活——通知 main 收口浏览器钩子
  },

  select: (id) => {
    set({ activeWorkspaceId: id });
    notifySwitch(id); // 用户切换 tab——main 侧切走旧 ws / 激活新 ws
  },

  getActive: () => {
    const { workspaces, activeWorkspaceId } = get();
    return workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  },

  setDefaultAgent: async (workspaceId, instanceId) => {
    set({ error: null });
    try {
      await ipc.workspace.setDefaultAgent(workspaceId, instanceId);
      // 刷新 workspace 列表以拿到新的 defaultAgentInstanceId
      const list = await ipc.workspace.list();
      set({ workspaces: list });
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  remove: async (id) => {
    set({ error: null });
    try {
      await ipc.workspace.delete(id);
      await get().load();
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  rename: async (id, name) => {
    set({ error: null });
    try {
      await ipc.workspace.rename(id, name);
      set((state) => ({
        workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, name } : w)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },
}));
