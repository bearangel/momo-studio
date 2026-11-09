// 设置页当前激活分类状态
import { create } from 'zustand';

// 分类键值需与 SettingsNav 的 CATEGORIES 同步——任一处遗漏会导致死分类。
// 2026-11-09：「git_policy」随设置页 Git 策略面板下线从 union 摘除（IPC 与组件保留）。
export type SettingsCategory =
  | 'model_provider'
  | 'default_model'
  | 'conversation'
  | 'memory'
  | 'appearance'
  | 'sandbox'
  | 'browser'
  | 'hub'
  | 'audit_log'
  | 'plugins'
  | 'about';

interface SettingsState {
  activeCategory: SettingsCategory;
  setCategory: (c: SettingsCategory) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  activeCategory: 'model_provider',
  setCategory: (c) => set({ activeCategory: c }),
}));
