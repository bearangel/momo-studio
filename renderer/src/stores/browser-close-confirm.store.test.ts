// renderer/src/stores/browser-close-confirm.store.test.ts
//
// 关闭浏览器确认 store 测试（spec §6.4）：
//   - 无 agent tab → request 直接销毁（不弹卡）
//   - 有 agent tab → 弹卡；cancel 不销毁；confirm 才销毁
//   - confirm 空 workspaceId 守卫（边界：不透传 null 给 closeBrowser）
// ipc 只 mock closeBrowser（进程边界，momo-test-rules：mock 收窄）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useBrowserCloseConfirmStore } from './browser-close-confirm.store';
import { ipc } from '../ipc/client';

vi.mock('../ipc/client', () => ({
  ipc: { browser: { closeBrowser: vi.fn(async () => {}) } },
}));

describe('browser-close-confirm store（spec §6.4）', () => {
  beforeEach(() => {
    useBrowserCloseConfirmStore.setState({ open: false, workspaceId: null });
    vi.clearAllMocks();
  });
  it('无 agent tab 的 request 直接关闭不弹卡', () => {
    useBrowserCloseConfirmStore.getState().request('w1', false);
    expect(useBrowserCloseConfirmStore.getState().open).toBe(false);
    expect(ipc.browser.closeBrowser).toHaveBeenCalledWith('w1');
  });
  it('有 agent tab 的 request 弹卡；confirm 才销毁；cancel 不销毁', () => {
    useBrowserCloseConfirmStore.getState().request('w1', true);
    expect(useBrowserCloseConfirmStore.getState().open).toBe(true);
    expect(ipc.browser.closeBrowser).not.toHaveBeenCalled();
    useBrowserCloseConfirmStore.getState().cancel();
    expect(useBrowserCloseConfirmStore.getState().open).toBe(false);
    useBrowserCloseConfirmStore.getState().request('w1', true);
    useBrowserCloseConfirmStore.getState().confirm();
    expect(ipc.browser.closeBrowser).toHaveBeenCalledWith('w1');
    expect(useBrowserCloseConfirmStore.getState().open).toBe(false);
  });
  it('confirm 空 workspaceId 守卫：不调 closeBrowser', () => {
    useBrowserCloseConfirmStore.getState().confirm();
    expect(useBrowserCloseConfirmStore.getState().open).toBe(false);
    expect(ipc.browser.closeBrowser).not.toHaveBeenCalled();
  });
});
