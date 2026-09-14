// renderer/src/components/workspace/BrowserWaitReleaseNotice.test.tsx
//
// 接管释放提示卡测试（spec 2026-09-14 §4.3，Task 3）：
//   - 非 agent-waiting-release kind → 不挂载
//   - kind='agent-waiting-release' → 卡片渲染（标题「agent 正在等待浏览器」+ 按钮「释放并继续」）
//   - browser:state 推送 takeover='agent'（目标 ws 匹配）→ 卸载
//   - durationMs 到期（+2s 宽限，fake timers）→ 卸载（超时兜底出口）
//   - state 的 workspaceId 与卡片目标不符 → 不卸载（用户切走查看其他 ws 不误删）
//   - 点击「释放并继续」→ releaseTakeover(notice.workspaceId) + 卡片消散
// mock 形态照抄 BrowserTrustNotice.test.tsx（window.api 桩 + ipc Proxy 透传）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserWaitReleaseNotice } from './BrowserWaitReleaseNotice';
import type { BrowserNotice, BrowserState } from '../../ipc/types';

const releaseTakeoverMock = vi.fn();
const onBrowserNoticeMock = vi.fn();
const onBrowserStateMock = vi.fn();

const mockApi = {
  browser: {
    releaseTakeover: releaseTakeoverMock,
    onBrowserNotice: onBrowserNoticeMock,
    onBrowserState: onBrowserStateMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

/** 构造最小 BrowserState 推送载荷（组件只消费 workspaceId + takeover） */
function mkState(workspaceId: string, takeover: BrowserState['takeover']): BrowserState {
  return {
    workspaceId,
    tabs: [],
    current: 0,
    url: '',
    title: '',
    takeover,
    trusted: false,
    collapsed: false,
  };
}

/** onBrowserNotice 桩：捕获回调 + 返回解订阅 spy */
function armOnBrowserNotice(): { push: (n: BrowserNotice) => void } {
  let captured: ((n: BrowserNotice) => void) | null = null;
  onBrowserNoticeMock.mockImplementation((cb: (n: BrowserNotice) => void) => {
    captured = cb;
    return vi.fn();
  });
  return { push: (n: BrowserNotice) => act(() => captured?.(n)) };
}

/** onBrowserState 桩：捕获回调（组件 notice 变更会重订阅，捕获最新闭包） */
function armOnBrowserState(): { push: (s: BrowserState) => void } {
  let captured: ((s: BrowserState) => void) | null = null;
  onBrowserStateMock.mockImplementation((cb: (s: BrowserState) => void) => {
    captured = cb;
    return vi.fn();
  });
  return { push: (s: BrowserState) => act(() => captured?.(s)) };
}

beforeEach(() => {
  releaseTakeoverMock.mockReset();
  onBrowserNoticeMock.mockReset();
  onBrowserStateMock.mockReset();
  releaseTakeoverMock.mockResolvedValue(undefined);
  // 默认实现仿真真实运行时语义：订阅永远返回解订阅函数（未 arm 的用例里
  // 组件仍要正常订阅/清理——真实 onBrowser* 不可能返回 undefined）
  onBrowserNoticeMock.mockImplementation(() => vi.fn());
  onBrowserStateMock.mockImplementation(() => vi.fn());
});

describe('BrowserWaitReleaseNotice（Task 3）', () => {
  it('非 agent-waiting-release kind（trust-request）→ 不挂载', () => {
    const { push } = armOnBrowserNotice();
    const { container } = render(<BrowserWaitReleaseNotice />);
    push({ kind: 'trust-request', text: 'agent 请求访问 example.com', workspaceId: 'w1' });
    expect(container.firstChild).toBeNull();
  });

  it('kind=agent-waiting-release → 渲染卡片（标题 + 推送 text + 按钮「释放并继续」）', () => {
    const { push } = armOnBrowserNotice();
    render(<BrowserWaitReleaseNotice />);
    push({ kind: 'agent-waiting-release', text: 'agent 等待浏览器释放（最长 30 秒）', workspaceId: 'w1' });
    expect(screen.getByTestId('browser-wait-release-notice')).toBeInTheDocument();
    expect(screen.getByText('agent 正在等待浏览器')).toBeInTheDocument();
    expect(screen.getByText('agent 等待浏览器释放（最长 30 秒）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '释放并继续' })).toBeInTheDocument();
  });

  it('onBrowserState 推送 takeover=agent（目标 ws 匹配）→ 卸载', () => {
    const notice = armOnBrowserNotice();
    const state = armOnBrowserState();
    render(<BrowserWaitReleaseNotice />);
    notice.push({ kind: 'agent-waiting-release', text: '...', workspaceId: 'w1' });
    expect(screen.getByTestId('browser-wait-release-notice')).toBeInTheDocument();
    state.push(mkState('w1', 'agent'));
    expect(screen.queryByTestId('browser-wait-release-notice')).toBeNull();
  });

  it('durationMs 到期（+2s 宽限）→ 卸载（超时兜底；宽限前不卸载）', () => {
    vi.useFakeTimers();
    try {
      const { push } = armOnBrowserNotice();
      render(<BrowserWaitReleaseNotice />);
      push({ kind: 'agent-waiting-release', text: '...', workspaceId: 'w1', durationMs: 5_000 });
      expect(screen.getByTestId('browser-wait-release-notice')).toBeInTheDocument();
      // 宽限 +2s：6_999ms 时尚未到期（takeover 不翻转时 state 不触发，靠本地计时）
      act(() => vi.advanceTimersByTime(6_999));
      expect(screen.getByTestId('browser-wait-release-notice')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByTestId('browser-wait-release-notice')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('state 的 workspaceId 与卡片目标不符 → 不卸载（用户切走查看其他 ws 不误删卡片）', () => {
    const notice = armOnBrowserNotice();
    const state = armOnBrowserState();
    render(<BrowserWaitReleaseNotice />);
    notice.push({ kind: 'agent-waiting-release', text: '...', workspaceId: 'w1' });
    state.push(mkState('w2', 'agent'));
    expect(screen.getByTestId('browser-wait-release-notice')).toBeInTheDocument();
  });

  it('点击「释放并继续」→ releaseTakeover(notice.workspaceId) + 卡片消散', async () => {
    const { push } = armOnBrowserNotice();
    render(<BrowserWaitReleaseNotice />);
    push({ kind: 'agent-waiting-release', text: '...', workspaceId: 'w1' });
    fireEvent.click(screen.getByRole('button', { name: '释放并继续' }));
    await waitFor(() => expect(releaseTakeoverMock).toHaveBeenCalledWith('w1'));
    await waitFor(() => expect(screen.queryByTestId('browser-wait-release-notice')).toBeNull());
  });
});
