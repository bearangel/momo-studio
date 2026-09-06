// ui.store 侧边栏状态测试（v2.2）：
// - 默认宽度 260 × 3、collapsed false；localStorage 预置值恢复
// - 非法持久化值（超范围/类型错/JSON 坏）→ 该项回默认 260
// - setSidebarWidth 钳制 [200, 480] 并四舍五入；写 round-trip
// - toggleSidebar 持久化；localStorage 写失败静默
//
// 加载语义测试用「预置 localStorage + vi.resetModules + 动态 import」仿真真实启动
//（store 初始值在模块加载时从 localStorage 读一次）。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const STORAGE_KEY = 'ui.sidebar.v1';

async function loadStore(): Promise<typeof import('./ui.store')> {
  vi.resetModules();
  return await import('./ui.store');
}

const seed = (widths: unknown, collapsed?: boolean): void => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ sidebarWidths: widths, sidebarCollapsed: collapsed ?? false }),
  );
};

describe('ui.store 侧边栏宽度与收起持久化', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('无持久化时：三视图默认 260px，未收起', async () => {
    const { useUiStore, SIDEBAR_WIDTH_DEFAULT } = await loadStore();
    expect(useUiStore.getState().sidebarWidths).toEqual({
      im: SIDEBAR_WIDTH_DEFAULT,
      files: SIDEBAR_WIDTH_DEFAULT,
      tasks: SIDEBAR_WIDTH_DEFAULT,
    });
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('持久化的合法宽度与收起状态在启动时恢复', async () => {
    seed({ im: 320, files: 200, tasks: 480 }, true);
    const { useUiStore } = await loadStore();
    expect(useUiStore.getState().sidebarWidths).toEqual({ im: 320, files: 200, tasks: 480 });
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  it('超范围/类型错的持久化项回默认 260，合法项保留', async () => {
    seed({ im: 150, files: 999, tasks: 'abc' });
    const { useUiStore, SIDEBAR_WIDTH_DEFAULT } = await loadStore();
    expect(useUiStore.getState().sidebarWidths).toEqual({
      im: SIDEBAR_WIDTH_DEFAULT,
      files: SIDEBAR_WIDTH_DEFAULT,
      tasks: SIDEBAR_WIDTH_DEFAULT,
    });
  });

  it('JSON 坏 / 字段缺失 → 全默认', async () => {
    localStorage.setItem(STORAGE_KEY, '{not-json');
    const mod1 = await loadStore();
    expect(mod1.useUiStore.getState().sidebarWidths.im).toBe(mod1.SIDEBAR_WIDTH_DEFAULT);

    localStorage.setItem(STORAGE_KEY, JSON.stringify({}));
    const mod2 = await loadStore();
    expect(mod2.useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('setSidebarWidth 钳制到 [200, 480] 并四舍五入，且写回 localStorage', async () => {
    const { useUiStore } = await loadStore();
    useUiStore.getState().setSidebarWidth('files', 199);
    useUiStore.getState().setSidebarWidth('im', 481);
    useUiStore.getState().setSidebarWidth('tasks', 300.6);

    const s = useUiStore.getState().sidebarWidths;
    expect(s).toEqual({ im: 480, files: 200, tasks: 301 });

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(persisted.sidebarWidths).toEqual({ im: 480, files: 200, tasks: 301 });
  });

  it('toggleSidebar 翻转并持久化收起状态', async () => {
    const { useUiStore } = await loadStore();
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').sidebarCollapsed).toBe(true);
  });

  it('localStorage 写失败静默，内存状态照常更新', async () => {
    const { useUiStore } = await loadStore();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => useUiStore.getState().setSidebarWidth('im', 300)).not.toThrow();
    expect(useUiStore.getState().sidebarWidths.im).toBe(300);
    expect(() => useUiStore.getState().toggleSidebar()).not.toThrow();
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    spy.mockRestore();
  });
});
