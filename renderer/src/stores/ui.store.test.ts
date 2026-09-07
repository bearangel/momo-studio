// ui.store 侧边栏状态测试（v2.2）：
// - 默认宽度 260 × 3、三视图均未收起；localStorage 预置值恢复
// - 非法持久化值（超范围/类型错/JSON 坏）→ 宽度项回默认 260；收起项回 false
// - 旧版共享 boolean 收起态按同值迁移到三视图（v2.2 优化前数据兼容）
// - setSidebarWidth 钳制 [200, 480] 并四舍五入；写 round-trip
// - toggleSidebar 按视图独立翻转并持久化；localStorage 写失败静默
//
// 加载语义测试用「预置 localStorage + vi.resetModules + 动态 import」仿真真实启动
//（store 初始值在模块加载时从 localStorage 读一次）。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const STORAGE_KEY = 'ui.sidebar.v1';

async function loadStore(): Promise<typeof import('./ui.store')> {
  vi.resetModules();
  return await import('./ui.store');
}

const seed = (widths: unknown, collapsed?: unknown): void => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ sidebarWidths: widths, sidebarCollapsed: collapsed ?? false }),
  );
};

const ALL_FALSE = { im: false, files: false, tasks: false };

describe('ui.store 侧边栏宽度与收起持久化', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('无持久化时：三视图默认 260px，均未收起', async () => {
    const { useUiStore, SIDEBAR_WIDTH_DEFAULT } = await loadStore();
    expect(useUiStore.getState().sidebarWidths).toEqual({
      im: SIDEBAR_WIDTH_DEFAULT,
      files: SIDEBAR_WIDTH_DEFAULT,
      tasks: SIDEBAR_WIDTH_DEFAULT,
    });
    expect(useUiStore.getState().sidebarCollapsed).toEqual(ALL_FALSE);
  });

  it('持久化的合法宽度与新对象形态收起状态在启动时恢复', async () => {
    seed({ im: 320, files: 200, tasks: 480 }, { im: true, files: false, tasks: true });
    const { useUiStore } = await loadStore();
    expect(useUiStore.getState().sidebarWidths).toEqual({ im: 320, files: 200, tasks: 480 });
    expect(useUiStore.getState().sidebarCollapsed).toEqual({
      im: true,
      files: false,
      tasks: true,
    });
  });

  it('旧版共享 boolean 收起态按同值迁移到三视图', async () => {
    seed({ im: 300, files: 260, tasks: 260 }, true);
    const { useUiStore } = await loadStore();
    expect(useUiStore.getState().sidebarCollapsed).toEqual({
      im: true,
      files: true,
      tasks: true,
    });
  });

  it('收起对象单项非法/缺失 → 该项回 false，合法项保留', async () => {
    seed(undefined, { im: 'yes', files: true });
    const { useUiStore } = await loadStore();
    expect(useUiStore.getState().sidebarCollapsed).toEqual({ im: false, files: true, tasks: false });
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
    expect(mod2.useUiStore.getState().sidebarCollapsed).toEqual(ALL_FALSE);
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

  it('toggleSidebar 按视图独立翻转并持久化', async () => {
    const { useUiStore } = await loadStore();
    useUiStore.getState().toggleSidebar('im');
    // 仅 im 翻转，其余视图不受影响
    expect(useUiStore.getState().sidebarCollapsed).toEqual({ im: true, files: false, tasks: false });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').sidebarCollapsed).toEqual({
      im: true,
      files: false,
      tasks: false,
    });

    // files 独立翻转，im 收起态保持
    useUiStore.getState().toggleSidebar('files');
    expect(useUiStore.getState().sidebarCollapsed).toEqual({ im: true, files: true, tasks: false });
  });

  it('localStorage 写失败静默，内存状态照常更新', async () => {
    const { useUiStore } = await loadStore();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => useUiStore.getState().setSidebarWidth('im', 300)).not.toThrow();
    expect(useUiStore.getState().sidebarWidths.im).toBe(300);
    expect(() => useUiStore.getState().toggleSidebar('im')).not.toThrow();
    expect(useUiStore.getState().sidebarCollapsed.im).toBe(true);
    spy.mockRestore();
  });
});
