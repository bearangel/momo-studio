// renderer/src/stores/auth.store.ts
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { AuthResult } from '../ipc/types';

export type AuthStatus = 'unknown' | 'unauthenticated' | 'authenticated';

interface AuthState {
  status: AuthStatus;
  user: AuthResult | null;
  error: string | null;
  loading: boolean;

  loadCurrent: () => Promise<void>;
  register: (opts: { username: string; password: string }) => Promise<void>;
  login: (opts: { username: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  reset: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'unknown',
  user: null,
  error: null,
  loading: false,

  loadCurrent: async () => {
    set({ loading: true, error: null });
    try {
      const user = await ipc.auth.getCurrentUser();
      if (user) {
        set({ status: 'authenticated', user, loading: false });
      } else {
        set({ status: 'unauthenticated', user: null, loading: false });
      }
    } catch (err) {
      set({ status: 'unauthenticated', loading: false, error: (err as Error).message });
    }
  },

  register: async (opts) => {
    set({ loading: true, error: null });
    try {
      const user = await ipc.auth.register(opts);
      set({ status: 'authenticated', user, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
      throw err;
    }
  },

  login: async (opts) => {
    set({ loading: true, error: null });
    try {
      const user = await ipc.auth.login(opts);
      set({ status: 'authenticated', user, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
      throw err;
    }
  },

  logout: async () => {
    await ipc.auth.logout();
    set({ status: 'unauthenticated', user: null });
  },

  reset: () => set({ status: 'unknown', user: null, error: null, loading: false }),
}));
