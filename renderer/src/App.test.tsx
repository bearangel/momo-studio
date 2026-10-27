// renderer/src/App.test.tsx
//
// v2.0 P1 Task 11：App 启动分支测试（无登录概念，SQLite 是唯一状态源）。
//   - 已有 workspace → 直接渲染 MainShell
//   - M2.1 D1：无 workspace → 同样渲染 MainShell 主壳（0-ws 不再整壳替换——
//     活动栏/工作组视图可达；创建表单随主区引导迁至 MiddlePanel，
//     表单流程回归锁见 MiddlePanel.test.tsx）
//   - 首启向导 pending → 向导接管（闩锁优先于主壳）
//
// P5 Task 2：升级首启提示集成
//   - getUpgradeNotice 命中 + workspace 存在 → MainShell + UpgradeNotice 同屏
//   - D1 后 0-ws 也走 MainShell 分支：命中标记同样渲染（不再被空态吞掉）
//   - 用户点「知道了」→ 调 dismissUpgradeNotice + 提示消失
//   - getUpgradeNotice 返回 null → 无提示（既有分支不变）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Workspace } from './ipc/types';
import { useSessionStore } from './stores/session.store';
import { useUiStore } from './stores/ui.store';

// MainShell 桩：分支断言只关心是否进入主界面；桩内挂真实 ActivityBar——
// M2.2 P2-8 需在 App 级断言 0-ws 态活动栏（含设置项）在场且可切换。
// ActivityBar 的插件面板 effect 在 0-ws 态短路（不触 ipc.plugin），ws 态由
// mockApi.plugin 桩承接，不扰动既有分支断言。
vi.mock('./routes/MainShell', async () => {
  const { ActivityBar } = await vi.importActual<
    typeof import('./components/layout/ActivityBar')
  >('./components/layout/ActivityBar');
  return {
    MainShell: () => (
      <div data-testid="main-shell">
        <ActivityBar />
      </div>
    ),
  };
});

import { App } from './App';

function mkWs(id: string): Workspace {
  return {
    id,
    name: `ws-${id}`,
    description: '',
    directoryPath: '/tmp/ws',
    gitInitialized: true,
    createdAt: '2026-01-01',
    ownerId: 'owner',
    iconEmoji: '📁',
    defaultAgentInstanceId: null,
  };
}

const mockApi = {
  workspace: {
    list: vi.fn(),
    create: vi.fn(),
    // M2.1 D3：App 顶层订阅 workspace:listChanged（推送面 no-op 桩）
    onListChanged: vi.fn().mockReturnValue(() => {}),
  },
  dialog: {
    pickDirectory: vi.fn().mockResolvedValue('/tmp/picked'),
  },
  session: {
    // App 顶层 subscribeSessionChannels 需要三条订阅通道（K10 加 onListChanged）
    onMessage: vi.fn().mockReturnValue(() => {}),
    onMessageEventBatch: vi.fn().mockReturnValue(() => {}),
    onListChanged: vi.fn().mockReturnValue(() => {}),
  },
  // TitleBar（P2 Task 3 空态接入）：平台 + 窗口控件通道
  system: {
    getPlatform: vi.fn().mockReturnValue('linux'),
    // P5 Task 2：升级提示标记读写
    getUpgradeNotice: vi.fn().mockResolvedValue(null),
    dismissUpgradeNotice: vi.fn().mockResolvedValue(undefined),
  },
  window: {
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    onMaximizedChanged: vi.fn().mockReturnValue(() => {}),
  },
  // 新装引导（spec 2026-10-10）：默认 skipped——既有分支断言走原空态不变；
  // 向导分支由专条用例覆盖（getStatus 回 pending）
  onboarding: {
    getStatus: vi.fn().mockResolvedValue({ status: 'skipped' as const }),
    markDone: vi.fn().mockResolvedValue(undefined),
    generatePlan: vi.fn(),
    applyPlan: vi.fn(),
  },
  // v2.4 Task 9：SandboxNotice 挂载拉取聚合信息——默认「已可用」使提示卡不渲染，
  // 既有分支断言不受影响
  sandbox: {
    getState: vi.fn(),
    reprobe: vi.fn(),
    installBwrap: vi.fn(),
    dismissPrompt: vi.fn(),
    onWriteBlocked: vi.fn(() => () => {}),
  },
  // v2.6.0 Task 6：ResumeNotice 挂载拉取中断任务——默认空列表使恢复卡不渲染，
  // 既有分支断言不受影响
  task: {
    listInterrupted: vi.fn(),
  },
  // v2.7 Task 8：browser 面（BrowserSidebar 消费；MainShell 桩下不实际渲染，
  // 默认 getState 空态 + 双订阅 no-op——保持 mockApi 形状与 ApiSurface 对齐）
  browser: {
    getState: vi.fn().mockResolvedValue({
      workspaceId: '',
      tabs: [],
      current: 0,
      url: '',
      title: '',
      takeover: 'agent' as const,
      trusted: false,
      expandHint: false,
    }),
    // 归属制（Task 5）：App 顶层 activeSessionId 上报 effect 消费
    setActiveSession: vi.fn().mockResolvedValue(undefined),
    onBrowserState: vi.fn().mockReturnValue(() => {}),
    onBrowserNotice: vi.fn().mockReturnValue(() => {}),
  },
  // P2-8：MainShell 桩内挂真实 ActivityBar——ws 态挂载会拉面板清单 + 订阅推送
  plugin: {
    listPanels: vi.fn().mockResolvedValue([]),
    onPanelsChanged: vi.fn().mockReturnValue(() => {}),
  },
};

// 默认 sandbox 聚合信息（linux 已可用 → SandboxNotice 返回 null）
function mkSandboxInfo() {
  return {
    state: {
      platform: 'linux',
      sandboxTool: 'bwrap' as const,
      toolVersion: '0.8.0',
      available: true,
      unavailableReason: null,
      windowsShell: null,
      executionPolicy: null,
      probedAt: 1757500000000,
    },
    settings: { mode: 'strict' as const, networkPolicy: 'allow' as const },
    installCommand: null,
    bwrapPromptDismissed: false,
    winPolicyPromptDismissed: false,
    netPromptDismissed: false,
  };
}

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  mockApi.workspace.list.mockReset();
  mockApi.workspace.create.mockReset();
  mockApi.system.getUpgradeNotice.mockReset();
  mockApi.system.dismissUpgradeNotice.mockReset();
  // 默认无升级标记——既有分支断言不受影响
  mockApi.system.getUpgradeNotice.mockResolvedValue(null);
  mockApi.system.dismissUpgradeNotice.mockResolvedValue(undefined);
  // 默认沙箱已可用——SandboxNotice 不渲染，既有断言不受影响
  mockApi.sandbox.getState.mockReset();
  mockApi.sandbox.getState.mockResolvedValue(mkSandboxInfo());
  // 默认无中断任务——ResumeNotice 不渲染，既有断言不受影响
  mockApi.task.listInterrupted.mockReset();
  mockApi.task.listInterrupted.mockResolvedValue([]);
});

describe('App 启动分支（v2.0 P1 Task 11）', () => {
  it('已有 workspace → 直接渲染 MainShell，不出现首启对话框', async () => {
    mockApi.workspace.list.mockResolvedValue([mkWs('w1')]);
    render(<App />);
    expect(await screen.findByTestId('main-shell')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '新建工作空间' })).not.toBeInTheDocument();
  });

  it('无 workspace → 渲染 MainShell 主壳（D1：0-ws 不整壳替换，工作组视图可达）', async () => {
    mockApi.workspace.list.mockResolvedValue([]);
    render(<App />);
    expect(await screen.findByTestId('main-shell')).toBeInTheDocument();
  });

  it('无 workspace 且引导 pending → 向导接管空态（spec 2026-10-10 §3.1）', async () => {
    mockApi.workspace.list.mockResolvedValue([]);
    mockApi.onboarding.getStatus.mockResolvedValueOnce({ status: 'pending' });
    render(<App />);
    expect(await screen.findByRole('button', { name: /AI 引导/ })).toBeInTheDocument();
    expect(screen.queryByTestId('main-shell')).not.toBeInTheDocument();
  });

  it('向导跳过（status=skipped）→ 0-ws 落回主壳而非向导重现', async () => {
    mockApi.workspace.list.mockResolvedValue([]);
    mockApi.onboarding.getStatus.mockResolvedValue({ status: 'skipped' });
    render(<App />);
    expect(await screen.findByTestId('main-shell')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /AI 引导/ })).not.toBeInTheDocument();
  });
});

describe('App 0-ws 设置可达（M2.2 P2-8）', () => {
  beforeEach(() => {
    useUiStore.setState({ activeView: 'im' });
  });

  it('0-ws 态渲染活动栏且含「设置」项', async () => {
    mockApi.workspace.list.mockResolvedValue([]);
    render(<App />);
    expect(await screen.findByTestId('main-shell')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
  });

  it('0-ws 态点击「设置」→ 切换到 settings 视图（激活态落在设置项）', async () => {
    mockApi.workspace.list.mockResolvedValue([]);
    render(<App />);
    await screen.findByTestId('main-shell');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(useUiStore.getState().activeView).toBe('settings');
    expect(screen.getByRole('button', { name: '设置' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('App 提示分级挂载（spec 2026-09-15 §4.2，M2）', () => {
  it('MainShell 分支常驻 CenterPromptLayer（Tier A 居中层——卡自管显隐，层不随卡消散）', async () => {
    mockApi.workspace.list.mockResolvedValue([mkWs('w1')]);
    render(<App />);
    expect(await screen.findByTestId('main-shell')).toBeInTheDocument();
    expect(screen.getByTestId('center-prompt-layer')).toBeInTheDocument();
    expect(screen.getByTestId('center-prompt-anchor')).toBeInTheDocument();
  });
});

describe('App 提示分级挂载（spec 2026-09-15 §4.3，M3）', () => {
  it('三自管卡渲染于 NoticeStack 容器内（Tier B 条目——防回退裸挂载四卡互盖）', async () => {
    mockApi.workspace.list.mockResolvedValue([mkWs('w1')]);
    // 三卡同时具备渲染条件：升级标记命中 + 沙箱 bwrap 不可用 + 存在中断任务
    mockApi.system.getUpgradeNotice.mockResolvedValue({
      exportDir: '/tmp/upgrade-export-x',
    });
    const info = mkSandboxInfo();
    mockApi.sandbox.getState.mockResolvedValue({
      ...info,
      installCommand: 'sudo apt install bubblewrap',
      state: { ...info.state, available: false, unavailableReason: 'bwrap 未安装' },
    });
    mockApi.task.listInterrupted.mockResolvedValue([
      {
        taskId: 'T-1',
        title: '中断任务',
        status: 'in_progress',
        agentName: 'coder',
        journalCount: 2,
        streamSessionId: 'stream-1',
      },
    ]);
    render(<App />);
    expect(await screen.findByTestId('main-shell')).toBeInTheDocument();
    const stack = screen.getByTestId('notice-stack');
    // 结构回归锁（spec §6 矩阵 5）：三卡必须同容器堆叠——任何一张裸挂载到
    // 容器外即回到「四卡同锚互盖」旧债（spec §1.1）
    expect(stack.contains(await screen.findByTestId('upgrade-notice'))).toBe(true);
    expect(stack.contains(await screen.findByTestId('sandbox-notice'))).toBe(true);
    expect(stack.contains(await screen.findByTestId('resume-notice'))).toBe(true);
  });
});

describe('App 升级提示集成（P5 Task 2）', () => {
  it('getUpgradeNotice 命中 + 已有 workspace → MainShell + UpgradeNotice 同屏', async () => {
    mockApi.workspace.list.mockResolvedValue([mkWs('w1')]);
    mockApi.system.getUpgradeNotice.mockResolvedValue({
      exportDir: '/tmp/upgrade-export-20260824-101530',
    });
    render(<App />);
    expect(await screen.findByTestId('main-shell')).toBeInTheDocument();
    expect(await screen.findByTestId('upgrade-notice')).toBeInTheDocument();
    expect(
      screen.getByText('/tmp/upgrade-export-20260824-101530'),
    ).toBeInTheDocument();
  });

  it('getUpgradeNotice 命中且无 workspace → 0-ws 主壳同屏 UpgradeNotice（D1：不再被空态吞掉）', async () => {
    mockApi.workspace.list.mockResolvedValue([]);
    mockApi.system.getUpgradeNotice.mockResolvedValue({
      exportDir: '/tmp/upgrade-export-x',
    });
    render(<App />);
    expect(await screen.findByTestId('main-shell')).toBeInTheDocument();
    expect(await screen.findByTestId('upgrade-notice')).toBeInTheDocument();
  });

  it('getUpgradeNotice 返回 null → 不渲染 UpgradeNotice（既有分支不变）', async () => {
    mockApi.workspace.list.mockResolvedValue([mkWs('w1')]);
    mockApi.system.getUpgradeNotice.mockResolvedValue(null);
    render(<App />);
    expect(await screen.findByTestId('main-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('upgrade-notice')).not.toBeInTheDocument();
  });

  it('点击「知道了」→ 调 dismissUpgradeNotice + UpgradeNotice 消失', async () => {
    mockApi.workspace.list.mockResolvedValue([mkWs('w1')]);
    mockApi.system.getUpgradeNotice.mockResolvedValue({
      exportDir: '/tmp/upgrade-export-x',
    });
    render(<App />);
    expect(await screen.findByTestId('upgrade-notice')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    await waitFor(() => {
      expect(screen.queryByTestId('upgrade-notice')).not.toBeInTheDocument();
    });
    expect(mockApi.system.dismissUpgradeNotice).toHaveBeenCalledTimes(1);
  });

  it('bootstrapped 后调一次 getUpgradeNotice（不重复调）', async () => {
    mockApi.workspace.list.mockResolvedValue([mkWs('w1')]);
    mockApi.system.getUpgradeNotice.mockResolvedValue({
      exportDir: '/tmp/upgrade-export-x',
    });
    render(<App />);
    await screen.findByTestId('upgrade-notice');
    // 等下一拍确保无二次调用
    await new Promise((r) => setTimeout(r, 10));
    expect(mockApi.system.getUpgradeNotice).toHaveBeenCalledTimes(1);
  });
});

describe('App 活跃会话上报（归属制 spec 2026-09-15 §5.4）', () => {
  it('挂载首报当前 activeSessionId + 变更后重报（null 安全缺省 → 字符串会话）', async () => {
    mockApi.workspace.list.mockResolvedValue([mkWs('w1')]);
    const report = mockApi.browser.setActiveSession;
    report.mockClear();
    act(() => {
      useSessionStore.setState({ activeSessionId: null });
    });

    render(<App />);
    expect(await screen.findByTestId('main-shell')).toBeInTheDocument();
    // 首报：启动即上报（null = 非会话视图，自动展开安全缺省输入）
    await waitFor(() => expect(report).toHaveBeenCalledWith(null));

    // 变更重报：effect 依赖 activeSessionId——切会话后再次上报新值
    act(() => {
      useSessionStore.setState({ activeSessionId: 'sess-1' });
    });
    await waitFor(() => expect(report).toHaveBeenCalledWith('sess-1'));
    // 调用序：首报 null 在前，重报 'sess-1' 在后（无中间乱序调用）
    expect(report.mock.calls.at(-2)).toEqual([null]);
    expect(report.mock.calls.at(-1)).toEqual(['sess-1']);
  });
});
