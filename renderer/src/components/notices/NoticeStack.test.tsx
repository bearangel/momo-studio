// renderer/src/components/notices/NoticeStack.test.tsx
//
// NoticeStack（Tier B 右下堆叠）测试：mock 骨架照抄 BrowserSidebar.test.tsx 的
// window.api 桩模式（onBrowserNotice 捕获 + 默认返回解订阅）。
// 覆盖：死信三 kind 路由（Tier A 两 kind 不入堆叠——防双渲染）、6s 自动消散
// （fake timers）、手动关闭、上限 4 条溢出计数、安全区避让定位（无侧栏 /
// 侧栏 rect.x=800 两种）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NoticeStack } from './NoticeStack';
import { useBrowserSidebarRectStore } from '../../stores/browser-sidebar-rect.store';
import type { BrowserNotice } from '../../ipc/types';

const onBrowserNoticeMock = vi.fn();
(globalThis as unknown as { window: { api: unknown } }).window.api = {
  browser: {
    onBrowserNotice: onBrowserNoticeMock,
    onBrowserState: vi.fn().mockReturnValue(() => {}),
  },
};

function armNotice(): { push: (n: BrowserNotice) => void } {
  let captured: ((n: BrowserNotice) => void) | null = null;
  onBrowserNoticeMock.mockImplementation((cb: (n: BrowserNotice) => void) => {
    captured = cb;
    return () => {};
  });
  return { push: (n: BrowserNotice) => act(() => captured?.(n)) };
}

beforeEach(() => {
  onBrowserNoticeMock.mockReset();
  onBrowserNoticeMock.mockReturnValue(() => {});
  useBrowserSidebarRectStore.getState().setRect(null);
});

describe('NoticeStack（Tier B 右下堆叠 + 死信补渲染）', () => {
  it('死信三 kind → toast 条目渲染；Tier A 两 kind 不在堆叠出现（防双渲染）', () => {
    const { push } = armNotice();
    render(<NoticeStack />);
    push({ kind: 'crash-reloaded', text: '页面崩溃已重载', workspaceId: 'w1' });
    push({ kind: 'popup-blocked', text: '弹窗已拦截', workspaceId: 'w1' });
    push({ kind: 'navigation-error', text: '加载失败', workspaceId: 'w1' });
    push({ kind: 'trust-request', text: 'x', workspaceId: 'w1' });
    push({ kind: 'agent-waiting-release', text: 'y', workspaceId: 'w1' });
    expect(screen.getAllByTestId('notice-toast')).toHaveLength(3);
    expect(screen.queryByText('x')).toBeNull();
    expect(screen.queryByText('y')).toBeNull();
  });

  it('6 秒自动消散（fake timers）', async () => {
    vi.useFakeTimers();
    try {
      const { push } = armNotice();
      render(<NoticeStack />);
      push({ kind: 'crash-reloaded', text: '稍后消散', workspaceId: 'w1' });
      expect(screen.getByTestId('notice-toast')).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(screen.queryByTestId('notice-toast')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('手动关闭 × 移除条目', () => {
    const { push } = armNotice();
    render(<NoticeStack />);
    push({ kind: 'popup-blocked', text: '手动关', workspaceId: 'w1' });
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByTestId('notice-toast')).toBeNull();
  });

  it('上限 4 条：超出丢最旧并显示「+N 条更早」计数行', () => {
    const { push } = armNotice();
    render(<NoticeStack />);
    for (let i = 1; i <= 6; i++) push({ kind: 'crash-reloaded', text: `t${i}`, workspaceId: 'w1' });
    expect(screen.getAllByTestId('notice-toast')).toHaveLength(4);
    expect(screen.getByTestId('notice-overflow').textContent).toContain('2');
    expect(screen.queryByText('t1')).toBeNull();
    expect(screen.queryByText('t2')).toBeNull();
    expect(screen.getByText('t3')).toBeInTheDocument();
  });

  it('定位避让：无侧栏 → right=16；侧栏 rect.x=800 → right=innerWidth-800+16', () => {
    const { push } = armNotice();
    render(<NoticeStack />);
    push({ kind: 'crash-reloaded', text: '定位', workspaceId: 'w1' });
    const stack = screen.getByTestId('notice-stack');
    expect(stack.style.right).toBe('16px');
    act(() => {
      useBrowserSidebarRectStore.getState().setRect({ x: 800, y: 40, width: 224, height: 700 });
    });
    expect(stack.style.right).toBe(`${window.innerWidth - 800 + 16}px`);
  });
});
