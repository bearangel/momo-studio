// renderer/src/stores/ui.store.ts
import { create } from 'zustand';

export type ViewKey = 'im' | 'files' | 'agents' | 'marketplace' | 'settings' | 'tasks';

interface UiState {
  activeView: ViewKey;
  setActiveView: (view: ViewKey) => void;
  /** v1.5.7: 侧边栏收起状态 */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeView: 'im',
  setActiveView: (view) => set({ activeView: view }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}));
