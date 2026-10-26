// renderer/src/components/workgroup/ViewPickerDialog.test.tsx
//
// 查看工作空间选择器测试（momo-hub M2.1 Task 4，视觉合同 S3b 屏）：
// - 多工作空间前置步：440px 弹窗（标题/副题/consent callout）+ 空间行（Folder +
//   名称 + chevron）；行点击 → store.pickWorkspace → viewWorkspace 定向拉取
// - 数据源 = hub-view.store 既有 picking 流（本机工作空间清单经 workspace.list
//   拉取——M2 协议无「远端空间清单」通道；行内会话/任务规模与「已镜像」徽标
//   数据源未接入，RM-M21-7 前不编造、不渲染）
// - 单空间直达：openPanel 自动选中（无选择器）
// - 空清单空态 / 取消关闭 / 错误人话（role=alert 防御路径）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ViewPickerDialog } from './ViewPickerDialog';
import { useHubViewStore } from '../../stores/hub-view.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

const api = {
  hub: {
    viewWorkspace: vi.fn(),
    viewSessions: vi.fn(),
    viewMessages: vi.fn(),
    viewTasks: vi.fn(),
    viewSubscribe: vi.fn(),
    viewUnsubscribe: vi.fn(),
    onViewAppended: vi.fn(() => () => undefined),
  },
  workspace: {
    list: vi.fn(),
    switch: vi.fn(async () => undefined),
  },
};

function openPanelMulti(): void {
  useHubViewStore.getState().openPanel({
    targetNodeId: 'node-b',
    targetName: 'studio-mini',
    workspaces: [
      { id: 'ws-1', name: 'product-dev' },
      { id: 'ws-2', name: 'lab' },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  api.hub.viewWorkspace.mockResolvedValue({
    overview: { name: 'lab', description: '', sessionCount: 0 },
    agentMembers: [], teams: [], mcpEnabled: [], skills: [], pluginsEnabled: [],
    resourcesSummary: { agent: 0, mcp: 0, skill: 0, plugin: 0 },
  });
  api.hub.viewSessions.mockResolvedValue({ sessions: [] });
  api.hub.viewTasks.mockResolvedValue({ tasks: [] });
  api.workspace.list.mockResolvedValue([
    { id: 'ws-1', name: 'product-dev' },
    { id: 'ws-2', name: 'lab' },
  ]);
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, loading: false, error: null });
  useHubViewStore.setState({
    open: false, picking: false, targetNodeId: null, targetName: null,
    workspaceId: null, workspaceName: null, tab: 'overview',
    overview: null, sessions: [], tasks: [], loading: false, error: null, replay: null,
  });
});

describe('ViewPickerDialog S3b 选择器', () => {
  it('多空间：弹窗（标题/副题/consent callout）+ 行点击 pickWorkspace → viewWorkspace 定向拉取', async () => {
    openPanelMulti();
    render(<ViewPickerDialog />);
    expect(await screen.findByRole('dialog', { name: '查看 studio-mini 的工作空间' })).toBeInTheDocument();
    expect(screen.getByText('远程只读 · 经 hub 定向拉取')).toBeInTheDocument();
    expect(screen.getByText(/对方关闭「允许本组查看」时列表不可用/)).toBeInTheDocument();
    expect(api.hub.viewWorkspace).not.toHaveBeenCalled(); // 选择前不拉取

    const row = await screen.findByRole('button', { name: '选择工作空间 lab' });
    fireEvent.click(row);
    await waitFor(() =>
      expect(api.hub.viewWorkspace).toHaveBeenCalledWith({ targetNodeId: 'node-b', workspaceName: 'lab' }),
    );
  });

  it('「已镜像」徽标与规模数据省略——RM-M21-7 登记表接入前不编造', async () => {
    openPanelMulti();
    render(<ViewPickerDialog />);
    await screen.findByRole('button', { name: '选择工作空间 product-dev' });
    expect(screen.queryByText('已镜像')).toBeNull();
    expect(screen.queryByText(/会话 ·/)).toBeNull();
  });

  it('单空间直达：openPanel 自动选中，不渲染选择器', async () => {
    useHubViewStore.getState().openPanel({
      targetNodeId: 'node-b',
      targetName: 'studio-mini',
      workspaces: [{ id: 'ws-1', name: 'product-dev' }],
    });
    render(<ViewPickerDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() =>
      expect(api.hub.viewWorkspace).toHaveBeenCalledWith({ targetNodeId: 'node-b', workspaceName: 'product-dev' }),
    );
  });

  it('空清单空态：本机无工作空间引导文案', async () => {
    api.workspace.list.mockResolvedValue([]);
    openPanelMulti();
    render(<ViewPickerDialog />);
    expect(await screen.findByText('本机尚无工作空间——先在工作空间页创建或镜像后查看')).toBeInTheDocument();
  });

  it('取消查看：关闭弹窗并置 open=false', async () => {
    openPanelMulti();
    render(<ViewPickerDialog />);
    await screen.findByRole('button', { name: '选择工作空间 product-dev' });
    fireEvent.click(screen.getByRole('button', { name: '取消查看' }));
    expect(useHubViewStore.getState().open).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('错误人话呈现（role=alert 防御路径——403 文案复用 humanizeViewError）', async () => {
    openPanelMulti();
    useHubViewStore.setState({ error: '对方节点关闭了本组查看——可在其「设置 → 节点互联」重新开启' });
    render(<ViewPickerDialog />);
    expect(await screen.findByRole('alert')).toHaveTextContent('对方节点关闭了本组查看');
  });
});
