// 主题状态机测试：默认跟随系统 / 持久化 / 非法值回退 / html class 副作用 / 系统变化跟随。
// matchMedia mock 形状对齐生产语义（真实监听器注册与触发，momo-test-rules）。
import { beforeEach, describe, expect, it, vi } from 'vitest';

// —— 忠实 mock matchMedia：捕获 listener，可编程触发 matches 变化 ——
type MediaListener = (e: { matches: boolean }) => void;
const listeners = new Set<MediaListener>();
let systemDark = false;
function installMatchMedia(): void {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: systemDark,
      media: query,
      onchange: null,
      addListener: (cb: MediaListener): void => {
        listeners.add(cb);
      },
      removeListener: (cb: MediaListener): void => {
        listeners.delete(cb);
      },
      addEventListener: (_type: string, cb: MediaListener): void => {
        listeners.add(cb);
      },
      removeEventListener: (_type: string, cb: MediaListener): void => {
        listeners.delete(cb);
      },
      dispatchEvent: (): boolean => false,
    }) as unknown as MediaQueryList;
}
function setSystemDark(v: boolean): void {
  systemDark = v;
  listeners.forEach((cb) => cb({ matches: v }));
}

// 每个用例重新 import store（模块级副作用：matchMedia 监听注册需要重放）
const importStore = (): Promise<typeof import('./theme.store')> => vi.importActual('./theme.store');

describe('theme.store', () => {
  beforeEach(() => {
    vi.resetModules();
    listeners.clear();
    systemDark = false;
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    installMatchMedia();
  });

  it('无持久化时默认 system，resolved 跟随当前系统偏好', async () => {
    setSystemDark(false);
    const { useThemeStore } = await importStore();
    expect(useThemeStore.getState().mode).toBe('system');
    expect(useThemeStore.getState().resolved).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('持久化 dark 时初始化即 resolved=dark 且 html 带 .dark', async () => {
    localStorage.setItem('momo.theme', 'dark');
    const { useThemeStore } = await importStore();
    expect(useThemeStore.getState().resolved).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('持久化非法值回退 system', async () => {
    localStorage.setItem('momo.theme', 'navy');
    const { useThemeStore } = await importStore();
    expect(useThemeStore.getState().mode).toBe('system');
  });

  it('setMode 切换主题：写 localStorage + 切 html class', async () => {
    const { useThemeStore } = await importStore();
    useThemeStore.getState().setMode('dark');
    expect(localStorage.getItem('momo.theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    useThemeStore.getState().setMode('light');
    expect(localStorage.getItem('momo.theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('system 模式下系统偏好变化实时跟随', async () => {
    const { useThemeStore } = await importStore();
    setSystemDark(true);
    expect(useThemeStore.getState().resolved).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    setSystemDark(false);
    expect(useThemeStore.getState().resolved).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('显式模式下系统偏好变化不覆盖用户选择', async () => {
    const { useThemeStore } = await importStore();
    useThemeStore.getState().setMode('light');
    setSystemDark(true);
    expect(useThemeStore.getState().resolved).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('显式切回 system 后恢复跟随', async () => {
    const { useThemeStore } = await importStore();
    useThemeStore.getState().setMode('light');
    setSystemDark(true);
    useThemeStore.getState().setMode('system');
    expect(useThemeStore.getState().resolved).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
