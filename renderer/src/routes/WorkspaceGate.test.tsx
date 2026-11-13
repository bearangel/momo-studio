// renderer/src/routes/WorkspaceGate.test.tsx
//
// WorkspaceGate（spec 2026-11-13 T2 §4.2）：跳过引导/0-ws 必填工作空间页。
// 无跳过出口；创建成功（activeWorkspaceId 翻转）后表单隐去（App 分支接管渲染）。
// 桩模式对齐 CreateWorkspaceDialog.test：window.api + useWorkspaceStore.setState。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkspaceGate } from './WorkspaceGate';
import { useWorkspaceStore } from '../stores/workspace.store';

const createWs = vi.fn();
const probePath = vi.fn();
const getWorkspaceDirSettings = vi.fn();
const listWs = vi.fn();

const mockApi = {
  dialog: { pickDirectory: vi.fn().mockResolvedValue(null) },
  workspace: { create: createWs, probePath, list: listWs, onListChanged: vi.fn().mockReturnValue(() => {}) },
  hub: { getWorkspaceDirSettings },
  window: {
    isMaximized: vi.fn().mockResolvedValue(false),
    onMaximizedChanged: vi.fn().mockReturnValue(() => {}),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  },
  system: { getPlatform: vi.fn().mockReturnValue('linux') },
};

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  getWorkspaceDirSettings.mockResolvedValue({
    rootDir: null,
    defaultRootDir: '/data/workspaces',
    effectiveRootDir: '/data/workspaces',
  });
  useWorkspaceStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    loading: false,
    error: null,
    closedIds: [],
    create: async (input: { name: string; directoryPath: string }) => createWs(input),
    select: vi.fn(),
    getActive: () => null,
    load: async () => undefined,
  });
});

describe('WorkspaceGate（spec 2026-11-13 T2）', () => {
  it('渲染标题与内嵌表单，无任何跳过出口且无取消按钮', () => {
    render(<WorkspaceGate />);
    expect(screen.getByText('设置工作空间')).toBeInTheDocument();
    expect(screen.getByText('新建工作空间')).toBeInTheDocument();
    expect(screen.queryByText(/跳过/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument();
  });

  it('创建成功（activeWorkspaceId 翻转）后表单隐去——渲染权交还 App 分支', async () => {
    probePath.mockResolvedValue({ exists: true, resolvedPath: '/tmp/ws', hasGit: false });
    createWs.mockImplementation(async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1' });
      return { id: 'ws-1', name: '演示', directoryPath: '/tmp/ws' };
    });
    render(<WorkspaceGate />);
    fireEvent.change(screen.getByPlaceholderText('我的项目'), {
      target: { value: '演示' },
    });
    fireEvent.change(screen.getByPlaceholderText('选择或输入目录路径'), {
      target: { value: '/tmp/ws' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^创建$/ }));
    expect(await screen.findByText('设置工作空间')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('我的项目')).not.toBeInTheDocument();
  });
});
