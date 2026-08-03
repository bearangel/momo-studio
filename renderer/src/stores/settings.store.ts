// 设置页当前激活分类状态
import { create } from 'zustand';

export type SettingsCategory = 'model_provider' | 'git_policy' | 'audit_log' | 'conversation';

interface SettingsState {
  activeCategory: SettingsCategory;
  setCategory: (c: SettingsCategory) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  activeCategory: 'model_provider',
  setCategory: (c) => set({ activeCategory: c }),
}));
