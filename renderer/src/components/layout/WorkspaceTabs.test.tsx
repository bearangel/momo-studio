// renderer/src/components/layout/WorkspaceTabs.test.tsx
//
// WorkspaceTabs 组件测试（P2 Task 2）：
// - 每个 workspace 渲染一个 tab；点击切换激活
// - 关闭 ×：confirm 确认后调 api.workspace.delete 并刷新列表；取消则不动
// - 右键菜单：重命名（inline input，Enter 提交 / Esc、blur 取消 / 空名不提交）
//   / 删除（confirm）/ 打开目录（失败 alert）
// - Esc / 点击菜单外部关闭菜单
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkspaceTabs } from './WorkspaceTabs';
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

const mockApi = {
  system: {
    getPlatform: vi.fn().mockReturnValue('linux'),
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

let confirmSpy: MockInstance<Parameters<typeof window.confirm>, ReturnType<typeof window.confirm>>;
let alertSpy: MockInstance<Parameters<typeof window.alert>, ReturnType<typeof window.alert>>;

describe('WorkspaceTabs', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useWorkspaceStore.setState({
      workspaces: [WS_A, WS_B],
      activeWorkspaceId: WS_A.id,
      loading: false,
      error: null,
    });
    mockApi.workspace.list.mockResolvedValue([]);
    mockApi.workspace.delete.mockResolvedValue(undefined);
    mockApi.workspace.delete.mockClear();
    mockApi.workspace.rename.mockResolvedValue({ ok: true });
    mockApi.workspace.rename.mockClear();
    mockApi.workspace.openDirectory.mockResolvedValue({ ok: true });
    mockApi.workspace.openDirectory.mockClear();
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    confirmSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('每个 workspace 渲染一个 tab', () => {
    render(<WorkspaceTabs />);
    expect(screen.getByRole('tab', { name: /产品重构/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /日常助手/ })).toBeInTheDocument();
  });

  it('点击 tab 切换激活 workspace', () => {
    render(<WorkspaceTabs />);
    fireEvent.click(screen.getByRole('tab', { name: /日常助手/ }));
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(WS_B.id);
  });

  it('点击 × confirm 确认后删除并刷新列表', async () => {
    mockApi.workspace.list.mockResolvedValue([WS_B]);
    render(<WorkspaceTabs />);
    fireEvent.click(screen.getByLabelText('关闭 产品重构'));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(mockApi.workspace.delete).toHaveBeenCalledWith(WS_A.id));
    await waitFor(() =>
      expect(useWorkspaceStore.getState().workspaces).toEqual([WS_B]),
    );
  });

  it('confirm 取消时不删除', () => {
    confirmSpy.mockReturnValue(false);
    render(<WorkspaceTabs />);
    fireEvent.click(screen.getByLabelText('关闭 产品重构'));
    expect(mockApi.workspace.delete).not.toHaveBeenCalled();
  });

  it('右键 tab 弹出菜单（重命名/打开目录/删除）', () => {
    render(<WorkspaceTabs />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
    expect(screen.getByText('重命名')).toBeInTheDocument();
    expect(screen.getByText('打开目录')).toBeInTheDocument();
    expect(screen.getByText('删除')).toBeInTheDocument();
  });

  it('菜单-打开目录：调 openDirectory 并关闭菜单', async () => {
    render(<WorkspaceTabs />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
    fireEvent.click(screen.getByText('打开目录'));

    await waitFor(() =>
      expect(mockApi.workspace.openDirectory).toHaveBeenCalledWith(WS_A.id),
    );
    expect(screen.queryByText('打开目录')).not.toBeInTheDocument();
  });

  it('菜单-打开目录失败时 alert 错误', async () => {
    mockApi.workspace.openDirectory.mockRejectedValue(new Error('打开目录失败: 目录不存在'));
    render(<WorkspaceTabs />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
    fireEvent.click(screen.getByText('打开目录'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('打开目录失败: 目录不存在'),
    );
  });

  it('菜单-重命名：inline input + Enter 提交调 rename 并更新本地名称', async () => {
    render(<WorkspaceTabs />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
    fireEvent.click(screen.getByText('重命名'));

    const input = screen.getByDisplayValue('产品重构');
    fireEvent.change(input, { target: { value: '新项目' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(mockApi.workspace.rename).toHaveBeenCalledWith(WS_A.id, '新项目'),
    );
    await waitFor(() =>
      expect(useWorkspaceStore.getState().workspaces[0]!.name).toBe('新项目'),
    );
    expect(screen.queryByDisplayValue('产品重构')).not.toBeInTheDocument();
  });

  it('重命名提交空名时不调 rename', () => {
    render(<WorkspaceTabs />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
    fireEvent.click(screen.getByText('重命名'));

    const input = screen.getByDisplayValue('产品重构');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockApi.workspace.rename).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue('产品重构')).not.toBeInTheDocument();
  });

  it('重命名失败时 alert 且本地名称不变', async () => {
    mockApi.workspace.rename.mockRejectedValue(new Error('重命名失败'));
    render(<WorkspaceTabs />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
    fireEvent.click(screen.getByText('重命名'));

    const input = screen.getByDisplayValue('产品重构');
    fireEvent.change(input, { target: { value: '新项目' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('重命名失败'));
    expect(useWorkspaceStore.getState().workspaces[0]!.name).toBe('产品重构');
  });

  it('重命名按 Esc 取消且不调 rename', () => {
    render(<WorkspaceTabs />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
    fireEvent.click(screen.getByText('重命名'));

    const input = screen.getByDisplayValue('产品重构');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(mockApi.workspace.rename).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue('产品重构')).not.toBeInTheDocument();
  });

  it('重命名 blur 取消且不调 rename', () => {
    render(<WorkspaceTabs />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
    fireEvent.click(screen.getByText('重命名'));

    fireEvent.blur(screen.getByDisplayValue('产品重构'));

    expect(mockApi.workspace.rename).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue('产品重构')).not.toBeInTheDocument();
  });

  it('菜单-删除：confirm 后调 delete', async () => {
    mockApi.workspace.list.mockResolvedValue([WS_B]);
    render(<WorkspaceTabs />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
    fireEvent.click(screen.getByText('删除'));

    await waitFor(() => expect(mockApi.workspace.delete).toHaveBeenCalledWith(WS_A.id));
  });

  it('按 Esc 关闭菜单', () => {
    render(<WorkspaceTabs />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
    expect(screen.getByText('重命名')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('重命名')).not.toBeInTheDocument();
  });

  it('点击菜单外部关闭菜单', () => {
    render(<WorkspaceTabs />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
    expect(screen.getByText('重命名')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('重命名')).not.toBeInTheDocument();
  });
});
