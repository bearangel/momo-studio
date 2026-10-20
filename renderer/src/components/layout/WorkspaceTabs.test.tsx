// renderer/src/components/layout/WorkspaceTabs.test.tsx
//
// WorkspaceTabs 组件测试（P2 Task 2 + 后续 UI 确认加固 + D6 关标签 ≠ 删除）：
// - 每个 workspace 渲染一个 tab；点击切换激活
// - D6：X / 菜单「关闭标签」只把 tab 从可见列表移除（closedIds），绝不调
//   ipc.workspace.delete、无确认弹窗；关闭激活标签自动切到剩余可见首个
// - 右键菜单：重命名（inline input，Enter 提交 / Esc、blur 取消 / 空名不提交）
//   / 打开目录（失败 alert）/ 分隔线 / 关闭标签 / 删除工作空间…（danger，
//   PromptDialog 输名确认后才真删；取消则不动）
// - 全部关闭 → ClosedWorkspacesPanel 列出全部 workspace，「重新打开」恢复
// - Esc / 点击菜单外部关闭菜单
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { WorkspaceTabs, ClosedWorkspacesPanel } from './WorkspaceTabs';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { Workspace } from '../../ipc/types';

const WS_A: Workspace = {
  id: 'ws-a',
  name: '产品重构',
  description: '',
  directoryPath: '/tmp/a',
  gitInitialized: true,
  createdAt: '2026-01-01T00:00:00Z',
  ownerId: 'owner',
  iconEmoji: '📁',
  defaultAgentInstanceId: null,
};
const WS_B: Workspace = { ...WS_A, id: 'ws-b', name: '日常助手', defaultAgentInstanceId: null };

const mockApi = {
  system: {
    getPlatform: vi.fn().mockReturnValue('linux'),
  },
  workspace: {
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue({ ok: true }),
    openDirectory: vi.fn().mockResolvedValue({ ok: true }),
    // 对齐真实 ApiSurface（T10 workspace:switch fire-and-forget——notifySwitch 会调用）
    switch: vi.fn().mockResolvedValue(undefined),
  },
  dialog: {
    pickDirectory: vi.fn().mockResolvedValue(null),
  },
};

let alertSpy: MockInstance<typeof window.alert>;

describe('WorkspaceTabs', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useWorkspaceStore.setState({
      workspaces: [WS_A, WS_B],
      activeWorkspaceId: WS_A.id,
      closedIds: [],
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
    mockApi.workspace.switch.mockClear();
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
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

  describe('D6：关闭标签 ≠ 删除', () => {
    it('点击 × 直接关闭标签：无确认弹窗、不调 delete、tab 从可见列表消失', () => {
      render(<WorkspaceTabs />);
      fireEvent.click(screen.getByLabelText('关闭标签 产品重构'));

      expect(screen.queryByText('确认删除工作空间')).not.toBeInTheDocument();
      expect(mockApi.workspace.delete).not.toHaveBeenCalled();
      expect(screen.queryByRole('tab', { name: /产品重构/ })).not.toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /日常助手/ })).toBeInTheDocument();
      // 工作空间本体保留在 store（只是标签不可见）
      expect(useWorkspaceStore.getState().workspaces).toHaveLength(2);
      expect(useWorkspaceStore.getState().closedIds).toEqual([WS_A.id]);
    });

    it('× 的 aria-label 为「关闭标签 {名称}」', () => {
      render(<WorkspaceTabs />);
      expect(screen.getByLabelText('关闭标签 产品重构')).toBeInTheDocument();
      expect(screen.queryByLabelText('关闭 产品重构')).not.toBeInTheDocument();
    });

    it('关闭激活标签 → 自动切到剩余可见首个', () => {
      render(<WorkspaceTabs />);
      fireEvent.click(screen.getByLabelText('关闭标签 产品重构'));
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(WS_B.id);
    });

    it('关闭非激活标签 → active 不变', () => {
      render(<WorkspaceTabs />);
      fireEvent.click(screen.getByLabelText('关闭标签 日常助手'));
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(WS_A.id);
    });

    it('右键菜单含「关闭标签」与 danger「删除工作空间…」，中间有分隔线', () => {
      render(<WorkspaceTabs />);
      fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
      expect(screen.getByText('重命名')).toBeInTheDocument();
      expect(screen.getByText('打开目录')).toBeInTheDocument();
      expect(screen.getByText('关闭标签')).toBeInTheDocument();
      const deleteItem = screen.getByText('删除工作空间…');
      expect(deleteItem).toBeInTheDocument();
      expect(deleteItem.className).toContain('text-status-error');
      // 分隔线（纯视觉 hr）
      expect(document.querySelector('.fixed .border-t')).not.toBeNull();
    });

    it('菜单-关闭标签：同样不调 delete 且 tab 消失', () => {
      render(<WorkspaceTabs />);
      fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
      fireEvent.click(screen.getByText('关闭标签'));

      expect(mockApi.workspace.delete).not.toHaveBeenCalled();
      expect(screen.queryByRole('tab', { name: /产品重构/ })).not.toBeInTheDocument();
      expect(screen.queryByText('关闭标签')).not.toBeInTheDocument();
    });

    it('菜单-删除工作空间…：弹 PromptDialog 输名确认（文案含 git 历史不可恢复）', () => {
      render(<WorkspaceTabs />);
      fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
      fireEvent.click(screen.getByText('删除工作空间…'));
      expect(screen.getByText('确认删除工作空间')).toBeInTheDocument();
      expect(screen.getByText(/git 历史/)).toBeInTheDocument();
      expect(screen.getByText(/不可恢复/)).toBeInTheDocument();
    });

    it('菜单-删除：输入正确名称 → 调 delete 并刷新列表', async () => {
      mockApi.workspace.list.mockResolvedValue([WS_B]);
      render(<WorkspaceTabs />);
      fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
      fireEvent.click(screen.getByText('删除工作空间…'));

      const dialog = screen.getByPlaceholderText('产品重构').closest('form') as HTMLElement;
      expect(dialog).not.toBeNull();
      fireEvent.change(within(dialog).getByPlaceholderText('产品重构'), {
        target: { value: '产品重构' },
      });
      fireEvent.submit(dialog);

      await waitFor(() => expect(mockApi.workspace.delete).toHaveBeenCalledWith(WS_A.id));
      await waitFor(() =>
        expect(useWorkspaceStore.getState().workspaces).toEqual([WS_B]),
      );
    });

    it('菜单-删除：输入错误名称 → 不调 delete，alert 告知错配', () => {
      render(<WorkspaceTabs />);
      fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
      fireEvent.click(screen.getByText('删除工作空间…'));

      const dialog = screen.getByPlaceholderText('产品重构').closest('form') as HTMLElement;
      expect(dialog).not.toBeNull();
      fireEvent.change(within(dialog).getByPlaceholderText('产品重构'), {
        target: { value: '别的名字' },
      });
      fireEvent.submit(dialog);

      expect(mockApi.workspace.delete).not.toHaveBeenCalled();
      expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('不一致'));
    });

    it('菜单-删除：点取消按钮 → 不调 delete，dialog 关闭', () => {
      render(<WorkspaceTabs />);
      fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
      fireEvent.click(screen.getByText('删除工作空间…'));
      expect(screen.getByText('确认删除工作空间')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '取消' }));

      expect(mockApi.workspace.delete).not.toHaveBeenCalled();
      expect(screen.queryByText('确认删除工作空间')).not.toBeInTheDocument();
    });

    it('删除当前激活 workspace → store 自动切到剩下首个（不残留已删 id）', async () => {
      mockApi.workspace.list.mockResolvedValue([WS_B]);
      render(<WorkspaceTabs />);
      fireEvent.contextMenu(screen.getByRole('tab', { name: /产品重构/ }));
      fireEvent.click(screen.getByText('删除工作空间…'));

      const dialog = screen.getByPlaceholderText('产品重构').closest('form') as HTMLElement;
      expect(dialog).not.toBeNull();
      fireEvent.change(within(dialog).getByPlaceholderText('产品重构'), {
        target: { value: '产品重构' },
      });
      fireEvent.submit(dialog);

      await waitFor(() =>
        expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(WS_B.id),
      );
    });
  });

  describe('ClosedWorkspacesPanel（全部关闭态）', () => {
    it('列出全部 workspace（含已关闭的）各带「重新打开」按钮', () => {
      useWorkspaceStore.setState({ closedIds: [WS_A.id, WS_B.id], activeWorkspaceId: null });
      render(<ClosedWorkspacesPanel />);

      expect(screen.getByText('已关闭全部工作空间标签')).toBeInTheDocument();
      expect(screen.getByText('工作空间仍保留在磁盘，可随时重新打开：')).toBeInTheDocument();
      const rowA = screen.getByText('产品重构').closest('li');
      const rowB = screen.getByText('日常助手').closest('li');
      expect(rowA).not.toBeNull();
      expect(rowB).not.toBeNull();
      expect(within(rowA as HTMLElement).getByRole('button', { name: '重新打开' })).toBeInTheDocument();
      expect(within(rowB as HTMLElement).getByRole('button', { name: '重新打开' })).toBeInTheDocument();
    });

    it('点「重新打开」→ reopenTab：移出 closedIds 并激活该 workspace', () => {
      useWorkspaceStore.setState({ closedIds: [WS_A.id, WS_B.id], activeWorkspaceId: null });
      render(<ClosedWorkspacesPanel />);

      const rowA = screen.getByText('产品重构').closest('li') as HTMLElement;
      fireEvent.click(within(rowA).getByRole('button', { name: '重新打开' }));

      const state = useWorkspaceStore.getState();
      expect(state.closedIds).toEqual([WS_B.id]);
      expect(state.activeWorkspaceId).toBe(WS_A.id);
      expect(mockApi.workspace.switch).toHaveBeenCalledWith(WS_A.id);
    });
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
