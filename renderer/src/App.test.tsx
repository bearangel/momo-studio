// renderer/src/App.test.tsx
//
// v2.0 P1 Task 11：App 启动分支测试（无登录概念，SQLite 是唯一状态源）。
//   - 已有 workspace → 直接渲染 MainShell
//   - 无 workspace → 全屏首启创建工作空间对话框（复用 CreateWorkspaceDialog）
//   - 首启创建成功 → 进入 MainShell
//
// P5 Task 2：升级首启提示集成
//   - getUpgradeNotice 命中 + workspace 存在 → MainShell + UpgradeNotice 同屏
//   - 用户点「知道了」→ 调 dismissUpgradeNotice + 提示消失
//   - getUpgradeNotice 返回 null → 无提示（既有分支不变）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Workspace } from './ipc/types';
import { useSessionStore } from './stores/session.store';

// MainShell 桩：分支断言只关心是否进入主界面，不关心其内部加载逻辑
vi.mock('./routes/MainShell', () => ({
  MainShell: () => <div data-testid="main-shell" />,
}));

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
  // v2.4 Task 9：SandboxNotice 挂载拉取聚合信息——默认「已可用」使提示卡不渲染，
  // 既有分支断言不受影响
  sandbox: {
    getState: vi.fn(),
    reprobe: vi.fn(),
    installBwrap: vi.fn(),
    dismissPrompt: vi.fn(),
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

  it('无 workspace → 显示首启创建工作空间对话框（不渲染 MainShell）', async () => {
    mockApi.workspace.list.mockResolvedValue([]);
    render(<App />);
    expect(await screen.findByRole('heading', { name: '新建工作空间' })).toBeInTheDocument();
    expect(screen.queryByTestId('main-shell')).not.toBeInTheDocument();
  });

  it('首启空态也渲染 TitleBar（frameless 下可拖拽/关闭，P2 Task 3）', async () => {
    mockApi.workspace.list.mockResolvedValue([]);
    render(<App />);
    await screen.findByRole('heading', { name: '新建工作空间' });
    // TitleBar 真实渲染：窗口关闭控件可见（TitleBar 未被 fixed 遮罩盖住）
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '最小化' })).toBeInTheDocument();
    // 零 workspace 时 tabs 仅剩 ＋（引导创建第一个 workspace）
    expect(screen.getByRole('button', { name: '新建工作空间' })).toBeInTheDocument();
  });

  it('首启对话框创建成功后进入 MainShell', async () => {
    // 有状态 list mock：创建成功后 list 返回新 workspace（模拟真实后端，
    // 同时覆盖 onClose → load() 的刷新路径不回退空态）
    let listResult: Workspace[] = [];
    mockApi.workspace.list.mockImplementation(() => Promise.resolve(listResult));
    mockApi.workspace.create.mockImplementation(() => {
      const ws = mkWs('w-new');
      listResult = [ws];
      return Promise.resolve(ws);
    });
    render(<App />);

    await screen.findByRole('heading', { name: '新建工作空间' });
    const inputs = document.querySelectorAll('input');
    fireEvent.change(inputs[0]!, { target: { value: '我的项目' } });
    fireEvent.change(inputs[1]!, { target: { value: '/tmp/project' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(mockApi.workspace.create).toHaveBeenCalledWith({
        name: '我的项目',
        directoryPath: '/tmp/project',
      });
    });
    expect(await screen.findByTestId('main-shell')).toBeInTheDocument();
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

  it('getUpgradeNotice 命中但无 workspace → 首启空态（UpgradeNotice 不渲染——首次启动分支不受影响）', async () => {
    mockApi.workspace.list.mockResolvedValue([]);
    mockApi.system.getUpgradeNotice.mockResolvedValue({
      exportDir: '/tmp/upgrade-export-x',
    });
    render(<App />);
    // 首启空态分支不应展示升级提示——新装用户无标记场景的反向边界
    expect(await screen.findByRole('heading', { name: '新建工作空间' })).toBeInTheDocument();
    expect(screen.queryByTestId('upgrade-notice')).not.toBeInTheDocument();
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
