// 设置页当前激活分类状态
import { create } from 'zustand';

// 分类键值需与 SettingsNav 的 CATEGORIES 同步——任一处遗漏会导致死分类。
export type SettingsCategory =
  | 'model_provider'
  | 'default_model'
  | 'conversation'
  | 'git_policy'
  | 'audit_log'
  | 'p2p'
  | 'about';

interface SettingsState {
  activeCategory: SettingsCategory;
  setCategory: (c: SettingsCategory) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  activeCategory: 'model_provider',
  setCategory: (c) => set({ activeCategory: c }),
}));
