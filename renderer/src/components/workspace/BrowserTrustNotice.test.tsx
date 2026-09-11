// renderer/src/components/workspace/BrowserTrustNotice.test.tsx
//
// 浏览器信任卡测试（v2.7 Task 9，spec §5.2）：
//   - 挂载订阅 onBrowserNotice + 卸载解订阅
//   - kind='trust-request' → 卡片渲染（标题 + 推送 text + 三按钮）
//   - 其他 kind（crash-reloaded 等）→ 不渲染
//   - 三按钮分流：本次会话允许 → answerTrust(wsId,'session') / 永久允许 →
//     'always' / 取消 → 'deny'；应答成功后卡片消散
//   - answerTrust 拒绝（错误路径）→ 卡片保留 + 错误行呈现
//   - 无活跃 workspace → 不渲染（应答无目标）
// mock 形态照抄 SandboxNotice.test.tsx（window.api 桩 + ipc Proxy 透传）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserTrustNotice } from './BrowserTrustNotice';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { BrowserNotice, Workspace } from '../../ipc/types';

const answerTrustMock = vi.fn();
const onBrowserNoticeMock = vi.fn();

const mockApi = {
  browser: {
    answerTrust: answerTrustMock,
    onBrowserNotice: onBrowserNoticeMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

const STUB_WORKSPACE: Workspace = {
  id: 'w1',
  name: 'Test',
  description: '',
  directoryPath: '/tmp/test',
  gitInitialized: false,
  createdAt: '2026-01-01T00:00:00Z',
  ownerId: 'owner',
  iconEmoji: '📁',
  defaultAgentInstanceId: null,
};

/** onBrowserNotice 桩默认行为：捕获回调 + 返回解订阅 spy */
function armOnBrowserNotice(): {
  push: (n: BrowserNotice) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let captured: ((n: BrowserNotice) => void) | null = null;
  const unsubscribe = vi.fn();
  onBrowserNoticeMock.mockImplementation((cb: (n: BrowserNotice) => void) => {
    captured = cb;
    return unsubscribe;
  });
  return {
    push: (n: BrowserNotice) => act(() => captured?.(n)),
    unsubscribe,
  };
}

beforeEach(() => {
  answerTrustMock.mockReset();
  onBrowserNoticeMock.mockReset();
  answerTrustMock.mockResolvedValue(undefined);
  useWorkspaceStore.setState({
    workspaces: [STUB_WORKSPACE],
    activeWorkspaceId: STUB_WORKSPACE.id,
    loading: false,
    error: null,
  });
});

describe('BrowserTrustNotice（v2.7 Task 9）', () => {
  it('挂载订阅 onBrowserNotice；卸载解订阅', () => {
    const { unsubscribe } = armOnBrowserNotice();
    const { unmount } = render(<BrowserTrustNotice />);
    expect(onBrowserNoticeMock).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('kind=trust-request → 渲染卡片（标题 + 推送 text + 三按钮）', () => {
    const { push } = armOnBrowserNotice();
    render(<BrowserTrustNotice />);
    push({ kind: 'trust-request', text: 'agent 请求访问 example.com' });
    expect(screen.getByTestId('browser-trust-notice')).toBeInTheDocument();
    expect(screen.getByText('agent 请求使用浏览器')).toBeInTheDocument();
    expect(screen.getByText('agent 请求访问 example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本次会话允许' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '永久允许' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
  });

  it('是非模态卡片（fixed 定位、非遮罩）', () => {
    const { push } = armOnBrowserNotice();
    const { container } = render(<BrowserTrustNotice />);
    push({ kind: 'trust-request', text: '...' });
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/fixed/);
    expect(root.className).toMatch(/right-/);
    expect(root.className).toMatch(/bottom-/);
    expect(root.className).not.toMatch(/inset-0/);
  });

  it('其他 kind（crash-reloaded）→ 不渲染', () => {
    const { push } = armOnBrowserNotice();
    const { container } = render(<BrowserTrustNotice />);
    push({ kind: 'crash-reloaded', text: '页面渲染进程崩溃，已自动重载' });
    expect(container.firstChild).toBeNull();
  });

  it('「本次会话允许」→ answerTrust(wsId, session) + 卡片消散', async () => {
    const { push } = armOnBrowserNotice();
    render(<BrowserTrustNotice />);
    push({ kind: 'trust-request', text: '...' });
    fireEvent.click(screen.getByRole('button', { name: '本次会话允许' }));
    await waitFor(() => expect(answerTrustMock).toHaveBeenCalledWith('w1', 'session'));
    await waitFor(() => expect(screen.queryByTestId('browser-trust-notice')).toBeNull());
  });

  it('「永久允许」→ answerTrust(wsId, always) + 卡片消散', async () => {
    const { push } = armOnBrowserNotice();
    render(<BrowserTrustNotice />);
    push({ kind: 'trust-request', text: '...' });
    fireEvent.click(screen.getByRole('button', { name: '永久允许' }));
    await waitFor(() => expect(answerTrustMock).toHaveBeenCalledWith('w1', 'always'));
    await waitFor(() => expect(screen.queryByTestId('browser-trust-notice')).toBeNull());
  });

  it('「取消」→ answerTrust(wsId, deny) + 卡片消散', async () => {
    const { push } = armOnBrowserNotice();
    render(<BrowserTrustNotice />);
    push({ kind: 'trust-request', text: '...' });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(answerTrustMock).toHaveBeenCalledWith('w1', 'deny'));
    await waitFor(() => expect(screen.queryByTestId('browser-trust-notice')).toBeNull());
  });

  it('answerTrust 拒绝 → 卡片保留 + 错误行呈现（不静默吞）', async () => {
    answerTrustMock.mockRejectedValue(new Error('IPC 通道不可用'));
    const { push } = armOnBrowserNotice();
    render(<BrowserTrustNotice />);
    push({ kind: 'trust-request', text: '...' });
    fireEvent.click(screen.getByRole('button', { name: '永久允许' }));
    await waitFor(() => {
      expect(screen.getByTestId('browser-trust-notice')).toBeInTheDocument();
    });
    expect(screen.getByText(/IPC 通道不可用/)).toBeInTheDocument();
  });

  it('应答 in-flight 时三按钮禁用（防双击双发）', async () => {
    let resolveAnswer: () => void = () => {};
    answerTrustMock.mockReturnValue(
      new Promise<void>((res) => {
        resolveAnswer = res;
      }),
    );
    const { push } = armOnBrowserNotice();
    render(<BrowserTrustNotice />);
    push({ kind: 'trust-request', text: '...' });
    fireEvent.click(screen.getByRole('button', { name: '本次会话允许' }));
    expect(screen.getByRole('button', { name: '本次会话允许' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '永久允许' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    await act(async () => {
      resolveAnswer();
    });
    await waitFor(() => expect(screen.queryByTestId('browser-trust-notice')).toBeNull());
  });

  it('无活跃 workspace → 推送也不渲染（应答无目标）', () => {
    useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null });
    const { push } = armOnBrowserNotice();
    const { container } = render(<BrowserTrustNotice />);
    push({ kind: 'trust-request', text: '...' });
    expect(container.firstChild).toBeNull();
  });
});
