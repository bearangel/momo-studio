// 主题运行时（v2.1 设计系统）：mode=用户意图（system/light/dark），resolved=实际生效。
// 纯 renderer 行为，无 IPC：Electron renderer 的 prefers-color-scheme 天然反映 OS 外观。
// localStorage 键 'momo.theme'；非法值/不可用一律回退 system。
import { create } from 'zustand';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'momo.theme';

function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // localStorage 不可用（极端环境）——跟随系统
  }
  return 'system';
}

function systemPrefersDark(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

/** 把 resolved 主题应用到 <html> 的 .dark class（幂等） */
export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  /** 仅 system 模式下消费系统偏好变化 */
  syncWithSystem: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const initialMode = readStoredMode();
  const initialResolved = resolveTheme(initialMode);
  // 初始化即应用（与 public/theme-boot.js 幂等双保险）
  applyTheme(initialResolved);

  return {
    mode: initialMode,
    resolved: initialResolved,
    setMode: (mode) => {
      try {
        localStorage.setItem(STORAGE_KEY, mode);
      } catch {
        // 持久化失败不阻塞切换（会话内仍生效）
      }
      const resolved = resolveTheme(mode);
      applyTheme(resolved);
      set({ mode, resolved });
    },
    syncWithSystem: () => {
      if (get().mode !== 'system') return;
      const resolved = resolveTheme('system');
      if (resolved !== get().resolved) {
        applyTheme(resolved);
        set({ resolved });
      }
    },
  };
});

// 跟随系统（renderer 单页应用，模块级注册一次即可）
if (typeof window.matchMedia === 'function') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    useThemeStore.getState().syncWithSystem();
  });
}
