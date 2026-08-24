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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Workspace } from './ipc/types';

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
    teamSessionId: 'sess-team',
    gitInitialized: true,
    createdAt: '2026-01-01',
    ownerId: 'owner',
    iconEmoji: '📁',
    coordinatorInstanceId: null,
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
    // App 顶层 subscribeSessionChannels 需要两条订阅通道
    onMessage: vi.fn().mockReturnValue(() => {}),
    onMessageEventBatch: vi.fn().mockReturnValue(() => {}),
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
};

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  mockApi.workspace.list.mockReset();
  mockApi.workspace.create.mockReset();
  mockApi.system.getUpgradeNotice.mockReset();
  mockApi.system.dismissUpgradeNotice.mockReset();
  // 默认无升级标记——既有分支断言不受影响
  mockApi.system.getUpgradeNotice.mockResolvedValue(null);
  mockApi.system.dismissUpgradeNotice.mockResolvedValue(undefined);
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