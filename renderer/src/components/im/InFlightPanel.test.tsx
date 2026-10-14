// renderer/src/components/im/InFlightPanel.test.tsx
//
// InFlightPanel（P2-D Task D2，spec 2026-10-13 §9）行为测试——Review Focus 五项：
//   1. 空在途：按钮无徽标；打开卡片显示空态文案「当前没有运行中的子任务」
//   2. 打开期间 2s 轮询：链转终态后下一帧从列表消失（真值驱动）
//   3. 取消：点击停止 → ipc.dispatch.cancelChain({ taskId })；不本地移除行
//      （乐观态不锁死）——轮询下一拍以主进程真值覆盖
//   4. subAgentName null → 降级渲染短 taskId（slice(0,8)），不出现空白名
//   5. 卸载清理 interval：clearInterval 被调 + 卸载后轮询不再发起
//
// mock 收窄在 IPC 边界（DispatchChip 同款：换 window.api，经真实 ipc Proxy 走
// wrapNamespace/wrapFunction——不 vi.mock client 模块，保真客户端包装层）；
// 列表数据用真实形状 InFlightChainView。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type { InFlightChainView } from '../../ipc/types';
import { InFlightPanel } from './InFlightPanel';
import { useWriteGrantStore } from '../../stores/write-grant.store';

// IPC 边界 mock：window.api.dispatch 只含被测面（listInFlight / cancelChain）
const listInFlightMock = vi.fn();
const cancelChainMock = vi.fn();
const mockApi = { dispatch: { listInFlight: listInFlightMock, cancelChain: cancelChainMock } };
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

/** 构造真实形状 InFlightChainView（默认有名子 agent，1 分钟前启动） */
function makeChain(overrides: Partial<InFlightChainView> = {}): InFlightChainView {
  return {
    taskId: 'task-000000000001',
    round: 2,
    sessionId: 'sess-1',
    pmAssignmentId: 'pm-inst-1',
    subAssignmentId: 'sub-inst-1',
    subStreamSessionId: 's-sub-1',
    pmStreamSessionId: 's-pm-1',
    startedAt: Date.now() - 60_000,
    subAgentName: '码农',
    ...overrides,
  };
}

/** 面板入口按钮（唯一 aria-expanded button；打开后行内另有停止按钮） */
function getToggleButton(): HTMLElement {
  const btn = document.querySelector<HTMLElement>('button[aria-expanded]');
  if (!btn) throw new Error('在途面板入口按钮未渲染');
  return btn;
}

/** 打开面板并冲刷首轮拉取的 promise 链（setChains 落地） */
async function openPanel(): Promise<void> {
  await act(async () => {
    fireEvent.click(getToggleButton());
  });
}

beforeEach(() => {
  listInFlightMock.mockReset().mockResolvedValue([]);
  cancelChainMock.mockReset().mockResolvedValue({ status: 'cancelled' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('InFlightPanel — 空在途（focus 1）', () => {
  it('空在途 → 打开卡片空态文案「当前没有运行中的子任务」；按钮无徽标', async () => {
    listInFlightMock.mockResolvedValue([]);
    const { container } = render(<InFlightPanel sessionId="sess-1" />);

    await openPanel();

    // 空态文案 + 标题计数 0
    expect(screen.getByText('当前没有运行中的子任务')).toBeInTheDocument();
    expect(screen.getByText('在途子任务（0）')).toBeInTheDocument();

    // 收起后徽标不渲染（空在途 chains.length === 0）
    await act(async () => {
      fireEvent.click(getToggleButton());
    });
    const badge = getToggleButton().querySelector('span');
    expect(badge).toBeNull();
    expect(container.textContent).not.toMatch(/在途子任务/);
  });
});

describe('InFlightPanel — 2s 轮询（focus 2）', () => {
  it('打开 → 立即拉取 + 2s 周期轮询；链转终态后下一帧从列表消失', async () => {
    vi.useFakeTimers();
    const running = makeChain();
    // 第 1 帧：1 条在途；第 2 帧（+2s）：链已终态，主进程不再返回
    listInFlightMock.mockResolvedValueOnce([running]).mockResolvedValue([]);

    render(<InFlightPanel sessionId="sess-1" />);
    await openPanel();

    // 打开即拉取（按会话过滤——preload 位置参数契约）
    expect(listInFlightMock).toHaveBeenCalledTimes(1);
    expect(listInFlightMock).toHaveBeenCalledWith('sess-1');
    expect(screen.getByText('码农')).toBeInTheDocument();

    // +2s 下一帧：终态链消失，空态文案接管
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(listInFlightMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('码农')).not.toBeInTheDocument();
    expect(screen.getByText('当前没有运行中的子任务')).toBeInTheDocument();
  });
});

describe('InFlightPanel — 单链取消（focus 3）', () => {
  it('停止按钮 → cancelChain({ taskId })；行不本地移除，轮询下一帧以真值覆盖', async () => {
    vi.useFakeTimers();
    const chain = makeChain({ taskId: 'task-cancel-me-1' });
    // 取消后首帧仍返回该链（主进程摘除有延迟）→ 再下一帧才消失：
    // 证明 UI 不乐观锁死（不本地删行），一切以轮询真值为准
    listInFlightMock.mockResolvedValueOnce([chain]).mockResolvedValueOnce([chain]).mockResolvedValue([]);

    render(<InFlightPanel sessionId="sess-1" />);
    await openPanel();
    expect(screen.getByText('码农')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '停止 码农 的任务' }));
    });
    expect(cancelChainMock).toHaveBeenCalledTimes(1);
    expect(cancelChainMock).toHaveBeenCalledWith({ taskId: 'task-cancel-me-1' });

    // 点击取消后行仍在（未本地移除）——乐观态不锁死的反面：真值未消失就不消失
    expect(screen.getByText('码农')).toBeInTheDocument();

    // +2s 真值仍含该链 → 行保持；再 +2s 真值消失 → 行移除
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText('码农')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.queryByText('码农')).not.toBeInTheDocument();
  });
});

describe('InFlightPanel — 链行渲染与 null 降级（focus 4）', () => {
  it('链行：名 + 短 taskId 降级 + 轮次 + 运行时长 + 停止按钮；徽标计数', async () => {
    const named = makeChain({ taskId: 'task-named-00001', round: 3 });
    const unnamed = makeChain({
      taskId: 'abcdefgh12345678',
      round: 1,
      subAssignmentId: 'sub-inst-2',
      subAgentName: null, // D1 解析失败（成员已删）→ null 降级
    });
    listInFlightMock.mockResolvedValue([named, unnamed]);

    render(<InFlightPanel sessionId="sess-1" />);
    await openPanel();

    // 有名链：名字 + 轮次 + 运行时长（60s 前 → 1m）+ 停止 aria-label
    expect(screen.getByText('码农')).toBeInTheDocument();
    expect(screen.getByText('第 3 轮')).toBeInTheDocument();
    // 两条链均 60s 前启动 → 各渲染一个 1m 运行时长
    expect(screen.getAllByText('1m')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '停止 码农 的任务' })).toBeInTheDocument();

    // null 链：降级短 taskId（前 8 位），不渲染空白名
    expect(screen.getByText('abcdefgh')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '停止 abcdefgh 的任务' })).toBeInTheDocument();
    expect(screen.getByText('在途子任务（2）')).toBeInTheDocument();

    // 收起 → 徽标显示在途数 2（open === false && chains.length > 0）
    await act(async () => {
      fireEvent.click(getToggleButton());
    });
    expect(within(getToggleButton()).getByText('2')).toBeInTheDocument();
  });
});

describe('InFlightPanel — 卸载清理（focus 5）', () => {
  it('卸载 → clearInterval 被调；卸载后轮询不再发起', async () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    listInFlightMock.mockResolvedValue([makeChain()]);

    const { unmount } = render(<InFlightPanel sessionId="sess-1" />);
    await openPanel();
    expect(listInFlightMock).toHaveBeenCalledTimes(1);

    // 轮询窗口内一次正常刷新，随后卸载
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(listInFlightMock).toHaveBeenCalledTimes(2);

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();

    // 卸载后推进 3 个周期：不再有任何拉取（interval 已清）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    // spy 必须还原：fakeTimers + spyOn 组合下残留会让后续用例的组件卸载
    // 调 clearInterval 时抛 ReferenceError（2026-10-14 F3 用例暴露）
    clearIntervalSpy.mockRestore();
    expect(listInFlightMock).toHaveBeenCalledTimes(2);
  });
});

// === F3（2026-10-14 后台链授权卡死配套）：等待授权态 + 行内处置 ===
describe('InFlightPanel 等待授权（F3）', () => {
  const grantWriteMock = vi.fn();
  const denyWriteMock = vi.fn();

  beforeEach(() => {
    (globalThis as unknown as { window: { api: unknown } }).window.api = {
      dispatch: { listInFlight: listInFlightMock, cancelChain: cancelChainMock },
      sandbox: { grantWrite: grantWriteMock, denyWrite: denyWriteMock },
    };
    grantWriteMock.mockReset().mockResolvedValue(undefined);
    denyWriteMock.mockReset().mockResolvedValue(undefined);
    useWriteGrantStore.getState().__resetForTest();
  });

  function seedWaiting(): void {
    useWriteGrantStore.getState().receiveWriteBlocked({
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      dirs: ['/ws/out'],
      command: 'mkdir -p out',
      streamSessionId: 's-sub-1',
      sourceAgentName: 'coder',
      sessionTitle: '团队功能与分工介绍',
    });
  }

  it('等待中的链：显示「等待授权」替代「第 N 轮」，出现授权/拒绝按钮、无停止按钮', async () => {
    listInFlightMock.mockResolvedValue([makeChain()]);
    render(<InFlightPanel sessionId="sess-1" />);
    seedWaiting();
    await openPanel();
    expect(screen.getByText('等待授权')).toBeInTheDocument();
    expect(screen.getByText('授权')).toBeInTheDocument();
    expect(screen.getByText('拒绝')).toBeInTheDocument();
    expect(screen.queryByLabelText(/停止 .+ 的任务/)).not.toBeInTheDocument();
  });

  it('点击授权 → sandbox.grantWrite(session 作用域) + 等待条目清除', async () => {
    listInFlightMock.mockResolvedValue([makeChain()]);
    render(<InFlightPanel sessionId="sess-1" />);
    seedWaiting();
    await openPanel();
    await act(async () => {
      fireEvent.click(screen.getByText('授权'));
    });
    expect(grantWriteMock).toHaveBeenCalledWith({ scope: 'session', key: 'sess-1', dirs: ['/ws/out'] });
    await act(async () => {});
    expect(useWriteGrantStore.getState().waitingByStream.has('s-sub-1')).toBe(false);
  });

  it('点击拒绝 → sandbox.denyWrite 广播 + 等待条目清除', async () => {
    listInFlightMock.mockResolvedValue([makeChain()]);
    render(<InFlightPanel sessionId="sess-1" />);
    seedWaiting();
    await openPanel();
    await act(async () => {
      fireEvent.click(screen.getByText('拒绝'));
    });
    expect(denyWriteMock).toHaveBeenCalledWith({ sessionId: 'sess-1', dirs: ['/ws/out'] });
    expect(useWriteGrantStore.getState().waitingByStream.has('s-sub-1')).toBe(false);
  });

  it('空 dirs 等待事件：授权禁用（提取失败防误授根目录），拒绝可用', async () => {
    listInFlightMock.mockResolvedValue([makeChain()]);
    render(<InFlightPanel sessionId="sess-1" />);
    useWriteGrantStore.getState().receiveWriteBlocked({
      sessionId: null, workspaceId: 'ws-1', dirs: [], command: 'x',
      streamSessionId: 's-sub-1', sourceAgentName: null, sessionTitle: null,
    });
    await openPanel();
    expect(screen.getByText('授权')).toBeDisabled();
    expect(screen.getByText('拒绝')).toBeEnabled();
  });
});
