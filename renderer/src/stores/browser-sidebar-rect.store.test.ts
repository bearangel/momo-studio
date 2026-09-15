// renderer/src/stores/browser-sidebar-rect.store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
// useSafeArea 的推导断言在 NoticeStack.test.tsx 经容器 style 数值间接锁——此处不导入。
import { useBrowserSidebarRectStore } from './browser-sidebar-rect.store';

beforeEach(() => useBrowserSidebarRectStore.getState().setRect(null));

describe('browser-sidebar-rect store + useSafeArea', () => {
  it('rect 缺省 null → 安全区为全窗口', () => {
    const s = useBrowserSidebarRectStore.getState();
    expect(s.rect).toBeNull();
  });

  it('setRect 写入 / 清 null 往返', () => {
    useBrowserSidebarRectStore.getState().setRect({ x: 800, y: 40, width: 224, height: 700 });
    expect(useBrowserSidebarRectStore.getState().rect).toEqual({ x: 800, y: 40, width: 224, height: 700 });
    useBrowserSidebarRectStore.getState().setRect(null);
    expect(useBrowserSidebarRectStore.getState().rect).toBeNull();
  });
});
