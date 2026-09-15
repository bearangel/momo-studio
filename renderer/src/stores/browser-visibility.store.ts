// renderer/src/stores/browser-visibility.store.ts
//
// 浏览器侧栏可见性（spec 2026-09-15 §9.1）：per-session 内存态——每个会话独立
// 记忆展开/收起，新会话缺省收起；不持久化（tab 本不跨重启）。销毁语义在
// main（setSidebarVisible），本 store 只管「当前会话想不想看见」。
import { create } from 'zustand';

interface BrowserVisibilityState {
  visibilityBySession: Record<string, boolean>;
  isVisible: (sessionId: string | null) => boolean;
  setVisible: (sessionId: string, visible: boolean) => void;
  /** 会话删除后的条目清理（alive = 仍存在的 sessionId 列表） */
  purgeStale: (alive: string[]) => void;
}

export const useBrowserVisibilityStore = create<BrowserVisibilityState>((set, get) => ({
  visibilityBySession: {},
  isVisible: (sessionId) => (sessionId === null ? false : get().visibilityBySession[sessionId] ?? false),
  setVisible: (sessionId, visible) =>
    set((s) => ({ visibilityBySession: { ...s.visibilityBySession, [sessionId]: visible } })),
  purgeStale: (alive) =>
    set((s) => {
      const next: Record<string, boolean> = {};
      for (const id of alive) {
        if (s.visibilityBySession[id] !== undefined) next[id] = s.visibilityBySession[id]!;
      }
      return { visibilityBySession: next };
    }),
}));
