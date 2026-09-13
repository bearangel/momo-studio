// renderer/src/components/settings/NetworkTrustCard.test.tsx
//
// 网络信任卡测试（v2.4.x，spec 2026-09-13 §6，方案 A 阻塞式）：
//   - 挂载订阅 onNetworkNotice + 卸载解订阅；只消费 net-trust-request
//   - 卡片渲染（标题 + 推送 text + 倒计时文案 + 三按钮）
//   - 三按钮分流：允许本次任务 → answerNetworkTrust(ssn,'session') / 永久允许 →
//     'always' / 保持拒绝 → 'deny'；应答成功后卡片消散
//   - 应答失败 → 卡片保留 + 错误行；in-flight 三按钮禁用
//   - 倒计时：随时间递减；窗口归零卡片自散（超时后主进程按拒绝收敛、补点 no-op）
//   - netBlockedSeen 置位（spec §6 防双弹——信任卡路径一并置位）
// mock 形态照抄 BrowserTrustNotice.test.tsx（window.api 桩）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NetworkTrustCard } from './NetworkTrustCard';
import { useStreamStore } from '../../stores/stream.store';
import type { NetworkTrustNotice } from '../../ipc/types';

const answerMock = vi.fn();
const onNetworkNoticeMock = vi.fn();

const mockApi = {
  sandbox: {
    getState: vi.fn(),
    reprobe: vi.fn(),
    installBwrap: vi.fn(),
    dismissPrompt: vi.fn(),
    answerNetworkTrust: answerMock,
    onNetworkNotice: onNetworkNoticeMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

function mkNotice(overrides?: Partial<NetworkTrustNotice>): NetworkTrustNotice {
  return {
    kind: 'net-trust-request',
    text: 'agent 的沙箱命令因网络被拦截而失败',
    streamSessionId: 'ssn-card-1',
    createdAt: Date.now(),
    ...overrides,
  };
}

/** onNetworkNotice 桩默认行为：捕获回调 + 返回解订阅 spy */
function armOnNetworkNotice(): {
  push: (n: NetworkTrustNotice) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let captured: ((n: NetworkTrustNotice) => void) | null = null;
  const unsubscribe = vi.fn();
  onNetworkNoticeMock.mockImplementation((cb: (n: NetworkTrustNotice) => void) => {
    captured = cb;
    return unsubscribe;
  });
  return {
    push: (n: NetworkTrustNotice) => act(() => captured?.(n)),
    unsubscribe,
  };
}

beforeEach(() => {
  answerMock.mockReset();
  onNetworkNoticeMock.mockReset();
  answerMock.mockResolvedValue(undefined);
  useStreamStore.setState({ netBlockedSeen: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NetworkTrustCard（v2.4.x spec §6）', () => {
  it('挂载订阅 onNetworkNotice；卸载解订阅', () => {
    const { unsubscribe } = armOnNetworkNotice();
    const { unmount } = render(<NetworkTrustCard />);
    expect(onNetworkNoticeMock).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('kind=net-trust-request → 渲染卡片（标题 + 推送 text + 倒计时 + 三按钮）', () => {
    const { push } = armOnNetworkNotice();
    render(<NetworkTrustCard />);
    push(mkNotice());
    expect(screen.getByTestId('network-trust-card')).toBeInTheDocument();
    expect(screen.getByText('agent 请求使用网络')).toBeInTheDocument();
    expect(screen.getByText('agent 的沙箱命令因网络被拦截而失败')).toBeInTheDocument();
    expect(screen.getByTestId('network-trust-countdown').textContent).toMatch(/秒内未应答将自动按拒绝处理/);
    expect(screen.getByRole('button', { name: '允许本次任务' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '永久允许' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保持拒绝' })).toBeInTheDocument();
  });

  it('是非模态卡片（fixed 定位、非遮罩）', () => {
    const { push } = armOnNetworkNotice();
    const { container } = render(<NetworkTrustCard />);
    push(mkNotice());
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/fixed/);
    expect(root.className).toMatch(/right-/);
    expect(root.className).toMatch(/bottom-/);
    expect(root.className).not.toMatch(/inset-0/);
  });

  it('其他 kind → 不渲染', () => {
    const { push } = armOnNetworkNotice();
    const { container } = render(<NetworkTrustCard />);
    push({ ...mkNotice(), kind: 'other-request' } as unknown as NetworkTrustNotice);
    expect(container.firstChild).toBeNull();
  });

  it('卡片出现即置位 netBlockedSeen（spec §6 防双弹：信任卡路径一并置位）', () => {
    const { push } = armOnNetworkNotice();
    render(<NetworkTrustCard />);
    expect(useStreamStore.getState().netBlockedSeen).toBe(false);
    push(mkNotice());
    expect(useStreamStore.getState().netBlockedSeen).toBe(true);
  });

  it('「允许本次任务」→ answerNetworkTrust(ssn, session) + 卡片消散', async () => {
    const { push } = armOnNetworkNotice();
    render(<NetworkTrustCard />);
    push(mkNotice());
    fireEvent.click(screen.getByRole('button', { name: '允许本次任务' }));
    await waitFor(() => expect(answerMock).toHaveBeenCalledWith('ssn-card-1', 'session'));
    await waitFor(() => expect(screen.queryByTestId('network-trust-card')).toBeNull());
  });

  it('「永久允许」→ answerNetworkTrust(ssn, always) + 卡片消散', async () => {
    const { push } = armOnNetworkNotice();
    render(<NetworkTrustCard />);
    push(mkNotice());
    fireEvent.click(screen.getByRole('button', { name: '永久允许' }));
    await waitFor(() => expect(answerMock).toHaveBeenCalledWith('ssn-card-1', 'always'));
    await waitFor(() => expect(screen.queryByTestId('network-trust-card')).toBeNull());
  });

  it('「保持拒绝」→ answerNetworkTrust(ssn, deny) + 卡片消散', async () => {
    const { push } = armOnNetworkNotice();
    render(<NetworkTrustCard />);
    push(mkNotice());
    fireEvent.click(screen.getByRole('button', { name: '保持拒绝' }));
    await waitFor(() => expect(answerMock).toHaveBeenCalledWith('ssn-card-1', 'deny'));
    await waitFor(() => expect(screen.queryByTestId('network-trust-card')).toBeNull());
  });

  it('应答按 notice.streamSessionId 路由（镜像 M7：应答回到发卡的任务流）', async () => {
    const { push } = armOnNetworkNotice();
    render(<NetworkTrustCard />);
    push(mkNotice({ streamSessionId: 'ssn-other-task' }));
    fireEvent.click(screen.getByRole('button', { name: '允许本次任务' }));
    await waitFor(() => expect(answerMock).toHaveBeenCalledWith('ssn-other-task', 'session'));
  });

  it('应答失败 → 卡片保留 + 错误行呈现（不静默吞）', async () => {
    answerMock.mockRejectedValue(new Error('IPC 通道不可用'));
    const { push } = armOnNetworkNotice();
    render(<NetworkTrustCard />);
    push(mkNotice());
    fireEvent.click(screen.getByRole('button', { name: '永久允许' }));
    await waitFor(() => {
      expect(screen.getByTestId('network-trust-card')).toBeInTheDocument();
    });
    expect(screen.getByText(/IPC 通道不可用/)).toBeInTheDocument();
  });

  it('应答 in-flight 时三按钮禁用（防双击双发）', async () => {
    let resolveAnswer: () => void = () => {};
    answerMock.mockReturnValue(
      new Promise<void>((res) => {
        resolveAnswer = res;
      }),
    );
    const { push } = armOnNetworkNotice();
    render(<NetworkTrustCard />);
    push(mkNotice());
    fireEvent.click(screen.getByRole('button', { name: '允许本次任务' }));
    expect(screen.getByRole('button', { name: '允许本次任务' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '永久允许' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保持拒绝' })).toBeDisabled();
    await act(async () => {
      resolveAnswer();
    });
    await waitFor(() => expect(screen.queryByTestId('network-trust-card')).toBeNull());
  });

  it('倒计时窗口归零 → 卡片自散（超时按拒绝收敛；此后补点为迟到 no-op）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    const { push } = armOnNetworkNotice();
    render(<NetworkTrustCard />);
    push(mkNotice({ createdAt: Date.now() }));
    expect(screen.getByTestId('network-trust-card')).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(181_000);
    });
    expect(screen.queryByTestId('network-trust-card')).toBeNull();
  });

  it('无推送时不渲染（常态 null）', () => {
    armOnNetworkNotice();
    const { container } = render(<NetworkTrustCard />);
    expect(container.firstChild).toBeNull();
  });
});
