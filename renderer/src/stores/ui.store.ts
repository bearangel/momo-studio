// renderer/src/stores/ui.store.ts
import { create } from 'zustand';

export type ViewKey = 'im' | 'files' | 'agents' | 'marketplace' | 'settings';

interface UiState {
  activeView: ViewKey;
  setActiveView: (view: ViewKey) => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeView: 'im',
  setActiveView: (view) => set({ activeView: view }),
}));
