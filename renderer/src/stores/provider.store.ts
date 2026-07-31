// 供应商注册表前端状态：列表 + CRUD 动作
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { ModelProvider } from '../ipc/types';

interface ProviderState {
  providers: ModelProvider[];
  loading: boolean;
  loadProviders: () => Promise<void>;
  createProvider: (input: { name: string; baseUrl: string; apiKey: string; defaultModel?: string; isDefault?: boolean }) => Promise<void>;
  updateProvider: (input: { id: string; name?: string; baseUrl?: string; apiKey?: string; defaultModel?: string; isDefault?: boolean }) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  setDefault: (id: string) => Promise<void>;
  /** 清空供应商列表（登出时调用） */
  clear: () => void;
}

export const useProviderStore = create<ProviderState>((set) => ({
  providers: [],
  loading: false,
  loadProviders: async () => {
    set({ loading: true });
    const providers = await ipc.provider.list();
    set({ providers, loading: false });
  },
  createProvider: async (input) => {
    await ipc.provider.create(input);
    const providers = await ipc.provider.list();
    set({ providers });
  },
  updateProvider: async (input) => {
    await ipc.provider.update(input);
    const providers = await ipc.provider.list();
    set({ providers });
  },
  deleteProvider: async (id) => {
    await ipc.provider.delete(id);
    const providers = await ipc.provider.list();
    set({ providers });
  },
  setDefault: async (id) => {
    await ipc.provider.setDefault(id);
    const providers = await ipc.provider.list();
    set({ providers });
  },
  clear: () => set({ providers: [], loading: false }),
}));
