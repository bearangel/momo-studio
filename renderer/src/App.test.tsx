// renderer/src/App.test.tsx
//
// v2.0 P1 Task 11：App 启动分支测试（无登录概念，SQLite 是唯一状态源）。
//   - 已有 workspace → 直接渲染 MainShell
//   - 无 workspace → 全屏首启创建工作空间对话框（复用 CreateWorkspaceDialog）
//   - 首启创建成功 → 进入 MainShell
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
};

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  mockApi.workspace.list.mockReset();
  mockApi.workspace.create.mockReset();
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
