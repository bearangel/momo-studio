// renderer/src/stores/capability.store.ts
//
// Workspace 级能力分配状态（三层能力模型的 Layer 2）。
// 增删走 allocation:* IPC，落库后重新拉取保证 UI 与 DB 一致。
// Layer 1（agent 定义默认能力）和 Layer 3（assignment extra）不在此 store 管理：
// 前者是 AgentDefinition 的只读字段，后者 schema 尚未引入。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { CapabilityType, WorkspaceAllocation } from '../ipc/types';

interface CapabilityState {
  allocation: WorkspaceAllocation | null;
  loading: boolean;
  error: string | null;

  load: (workspaceId: string) => Promise<void>;
  add: (workspaceId: string, type: CapabilityType, ref: string) => Promise<void>;
  remove: (workspaceId: string, type: CapabilityType, ref: string) => Promise<void>;
  reset: () => void;
}

const EMPTY = (workspaceId: string): WorkspaceAllocation => ({
  workspaceId,
  tools: [],
  mcps: [],
  skills: [],
});

export const useCapabilityStore = create<CapabilityState>((set) => ({
  allocation: null,
  loading: false,
  error: null,

  load: async (workspaceId) => {
    set({ loading: true, error: null });
    try {
      const allocation = await ipc.allocation.get(workspaceId);
      set({ allocation, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  add: async (workspaceId, type, ref) => {
    set({ error: null });
    try {
      await ipc.allocation.add(workspaceId, type, ref);
      const allocation = await ipc.allocation.get(workspaceId);
      set({ allocation });
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  remove: async (workspaceId, type, ref) => {
    set({ error: null });
    try {
      await ipc.allocation.remove(workspaceId, type, ref);
      const allocation = await ipc.allocation.get(workspaceId);
      set({ allocation });
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  reset: () => set({ allocation: null, loading: false, error: null }),
}));

export { EMPTY as emptyAllocation };
