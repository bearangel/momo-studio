// renderer/src/components/notices/BrowserCloseConfirmCard.test.tsx
//
// 关闭浏览器确认卡测试（spec §6.4 / §9.3）：
//   - open=false 不渲染；request(有 agent tab) 弹卡
//   - 取消 → 卡消失且不销毁浏览器（负断言，同测试内以 confirm 路径作
//     确定性正对照——Task 5 F1 教训：防 ipc 接线断裂的 vacuous pass）
//   - 强制关闭 → closeBrowser(workspaceId) 且卡消失
// store 驱动显隐用 act 同步断言（禁固定 sleep）；ipc 只 mock closeBrowser。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { BrowserCloseConfirmCard } from './BrowserCloseConfirmCard';
import { useBrowserCloseConfirmStore } from '../../stores/browser-close-confirm.store';
import { ipc } from '../../ipc/client';

vi.mock('../../ipc/client', () => ({
  ipc: { browser: { closeBrowser: vi.fn(async () => {}) } },
}));

beforeEach(() => {
  useBrowserCloseConfirmStore.setState({ open: false, workspaceId: null });
  vi.clearAllMocks();
});

describe('BrowserCloseConfirmCard（spec §6.4）', () => {
  it('open=false 不渲染；request(有 agent tab) → 弹居中确认卡', () => {
    render(<BrowserCloseConfirmCard />);
    expect(screen.queryByTestId('browser-close-confirm')).not.toBeInTheDocument();
    act(() => {
      useBrowserCloseConfirmStore.getState().request('w1', true);
    });
    expect(screen.getByTestId('browser-close-confirm')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog', { name: '关闭浏览器确认' })).toBeInTheDocument();
  });

  it('取消 → 卡消失且不调 closeBrowser；同链路 confirm 正对照', () => {
    render(<BrowserCloseConfirmCard />);
    act(() => {
      useBrowserCloseConfirmStore.getState().request('w1', true);
    });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByTestId('browser-close-confirm')).not.toBeInTheDocument();
    expect(ipc.browser.closeBrowser).not.toHaveBeenCalled();
    // 正对照：同 mock 同链路下 confirm 确实触发调用——上面的负断言才可信
    act(() => {
      useBrowserCloseConfirmStore.getState().request('w1', true);
    });
    fireEvent.click(screen.getByRole('button', { name: '强制关闭' }));
    expect(ipc.browser.closeBrowser).toHaveBeenCalledWith('w1');
    expect(screen.queryByTestId('browser-close-confirm')).not.toBeInTheDocument();
  });

  it('强制关闭 → closeBrowser(workspaceId) 且卡消失', () => {
    render(<BrowserCloseConfirmCard />);
    act(() => {
      useBrowserCloseConfirmStore.getState().request('w2', true);
    });
    fireEvent.click(screen.getByRole('button', { name: '强制关闭' }));
    expect(ipc.browser.closeBrowser).toHaveBeenCalledWith('w2');
    expect(screen.queryByTestId('browser-close-confirm')).not.toBeInTheDocument();
  });
});
