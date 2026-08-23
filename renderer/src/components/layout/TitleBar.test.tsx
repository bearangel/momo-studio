// renderer/src/components/layout/TitleBar.test.tsx
//
// TitleBar 组件测试（P2 Task 2）：
// - 渲染 workspace tabs（store 直连）＋激活高亮＋点击切换
// - ＋ 按钮打开 CreateWorkspaceDialog
// - 窗口控件三按钮分别调 api.window.minimize/toggleMaximize/close
// - isMaximized 初始化 + onMaximizedChanged 推送切换最大化/还原图标
// - mac 平台不渲染自绘控件与 Logo（原生红绿灯）
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TitleBar } from './TitleBar';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { Workspace } from '../../ipc/types';

const WS_A: Workspace = {
  id: 'ws-a',
  name: '产品重构',
  description: '',
  directoryPath: '/tmp/a',
  teamSessionId: 'sess-a',
  gitInitialized: true,
  createdAt: '2026-01-01T00:00:00Z',
  ownerId: 'owner',
  iconEmoji: '📁',
  coordinatorInstanceId: null,
};
const WS_B: Workspace = { ...WS_A, id: 'ws-b', name: '日常助手', teamSessionId: 'sess-b' };

// onMaximizedChanged 回调捕获（模拟主进程 maximize/unmaximize 推送）
let maximizedCb: ((maximized: boolean) => void) | null = null;

const mockApi = {
  system: {
    getPlatform: vi.fn().mockReturnValue('linux'),
  },
  window: {
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    onMaximizedChanged: vi.fn().mockImplementation((cb: (m: boolean) => void) => {
      maximizedCb = cb;
      return () => {};
    }),
  },
  workspace: {
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue({ ok: true }),
    openDirectory: vi.fn().mockResolvedValue({ ok: true }),
  },
  dialog: {
    pickDirectory: vi.fn().mockResolvedValue(null),
  },
};

describe('TitleBar', () => {
  beforeEach(() => {
    // 只替换 window.api（保留 jsdom Window 其余能力），ipc client proxy 转发到此
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useWorkspaceStore.setState({
      workspaces: [WS_A, WS_B],
      activeWorkspaceId: WS_A.id,
      loading: false,
      error: null,
    });
    maximizedCb = null;
    mockApi.system.getPlatform.mockReturnValue('linux');
    mockApi.window.isMaximized.mockResolvedValue(false);
    mockApi.window.minimize.mockClear();
    mockApi.window.toggleMaximize.mockClear();
    mockApi.window.close.mockClear();
  });

  it('渲染 workspace tabs，激活 tab 高亮', () => {
    render(<TitleBar />);
    expect(screen.getByRole('tab', { name: /产品重构/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /日常助手/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('点击 tab 切换激活 workspace', () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByRole('tab', { name: /日常助手/ }));
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(WS_B.id);
  });

  it('点击 ＋ 打开 CreateWorkspaceDialog', () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByLabelText('新建工作空间'));
    expect(screen.getByRole('heading', { name: '新建工作空间' })).toBeInTheDocument();
  });

  it('窗口控件三按钮分别调用 minimize/toggleMaximize/close', () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByLabelText('最小化'));
    expect(mockApi.window.minimize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('最大化'));
    expect(mockApi.window.toggleMaximize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(mockApi.window.close).toHaveBeenCalledTimes(1);
  });

  it('onMaximizedChanged 推送切换最大化/还原图标', async () => {
    render(<TitleBar />);
    expect(screen.getByLabelText('最大化')).toBeInTheDocument();
    expect(screen.queryByLabelText('还原')).not.toBeInTheDocument();

    act(() => maximizedCb?.(true));
    expect(screen.getByLabelText('还原')).toBeInTheDocument();
    expect(screen.queryByLabelText('最大化')).not.toBeInTheDocument();
  });

  it('mac 平台不渲染自绘窗口控件与 Logo', () => {
    mockApi.system.getPlatform.mockReturnValue('darwin');
    render(<TitleBar />);
    expect(screen.queryByLabelText('最小化')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('关闭')).not.toBeInTheDocument();
    expect(screen.queryByText('Momo Studio')).not.toBeInTheDocument();
  });
});
