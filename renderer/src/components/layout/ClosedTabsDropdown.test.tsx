// renderer/src/components/layout/ClosedTabsDropdown.test.tsx
//
// ClosedTabsDropdown 测试（真实 store + window.api mock，对齐
// WorkspaceTabs.test.tsx 先例——store 逻辑不 mock，只 mock IPC 边界）：
// - 空态：closedIds 为空 / 只含死 id（workspace 已删）→ 入口整体不渲染
// - 展开列表只含已关闭 workspace（未关闭的不出现）
// - 点击条目 → reopenTab 真实语义：移出 closedIds、激活该 ws、
//   workspace:switch 通知 main（契约：生产消费的 IPC 调用必须发生）
// - Escape / 点击外部关闭菜单；重开最后一个条目后入口消失
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ClosedTabsDropdown } from './ClosedTabsDropdown';
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
    // reopenTab → select → notifySwitch 会调用（fire-and-forget）
    switch: vi.fn().mockResolvedValue(undefined),
  },
};

describe('ClosedTabsDropdown', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useWorkspaceStore.setState({
      workspaces: [WS_A, WS_B],
      activeWorkspaceId: WS_A.id,
      closedIds: [],
      loading: false,
      error: null,
    });
    mockApi.workspace.switch.mockClear();
  });

  it('closedIds 为空 → 入口整体不渲染', () => {
    render(<ClosedTabsDropdown />);
    expect(screen.queryByLabelText('已关闭的工作空间')).not.toBeInTheDocument();
  });

  it('closedIds 只含死 id（workspace 已删）→ 同样不渲染', () => {
    useWorkspaceStore.setState({ closedIds: ['ws-ghost'] });
    render(<ClosedTabsDropdown />);
    expect(screen.queryByLabelText('已关闭的工作空间')).not.toBeInTheDocument();
  });

  it('有已关闭空间 → 按钮出现，aria-expanded 初始 false', () => {
    useWorkspaceStore.setState({ closedIds: [WS_B.id] });
    render(<ClosedTabsDropdown />);
    const btn = screen.getByLabelText('已关闭的工作空间');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('点击展开：menu 列出已关闭 workspace，未关闭的不出现', () => {
    useWorkspaceStore.setState({ closedIds: [WS_B.id] });
    render(<ClosedTabsDropdown />);
    fireEvent.click(screen.getByLabelText('已关闭的工作空间'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '日常助手' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '产品重构' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('已关闭的工作空间')).toHaveAttribute('aria-expanded', 'true');
  });

  it('下拉面板有一致最小宽度（minWidth 216），标题不折行', () => {
    // 回归锁：absolute 容器 shrink-to-fit，短名 workspace 曾把面板压窄到
    // 标题「已关闭的工作空间」折 3 行（2026-10-22 dev 实测）
    useWorkspaceStore.setState({ closedIds: [WS_B.id] });
    render(<ClosedTabsDropdown />);
    fireEvent.click(screen.getByLabelText('已关闭的工作空间'));

    expect(screen.getByRole('menu')).toHaveStyle({ minWidth: '216px' });
    expect(screen.getByText('已关闭的工作空间').className).toContain('whitespace-nowrap');
  });

  it('点击条目 → reopenTab 真实语义：移出 closedIds、激活、通知 main 切换', () => {
    useWorkspaceStore.setState({ closedIds: [WS_B.id] });
    render(<ClosedTabsDropdown />);
    fireEvent.click(screen.getByLabelText('已关闭的工作空间'));
    fireEvent.click(screen.getByRole('menuitem', { name: '日常助手' }));

    const state = useWorkspaceStore.getState();
    expect(state.closedIds).toEqual([]);
    expect(state.activeWorkspaceId).toBe(WS_B.id);
    expect(mockApi.workspace.switch).toHaveBeenCalledWith(WS_B.id);
    // closedIds 清空 → 入口随之消失
    expect(screen.queryByLabelText('已关闭的工作空间')).not.toBeInTheDocument();
  });

  it('重开非最后一个条目 → 入口保留、列表只剩其余项', () => {
    useWorkspaceStore.setState({ closedIds: [WS_A.id, WS_B.id], activeWorkspaceId: null });
    render(<ClosedTabsDropdown />);
    fireEvent.click(screen.getByLabelText('已关闭的工作空间'));
    fireEvent.click(screen.getByRole('menuitem', { name: '产品重构' }));

    expect(useWorkspaceStore.getState().closedIds).toEqual([WS_B.id]);
    expect(screen.getByLabelText('已关闭的工作空间')).toBeInTheDocument();
    // 菜单点击后收起
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Escape 关闭菜单但入口保留', () => {
    useWorkspaceStore.setState({ closedIds: [WS_B.id] });
    render(<ClosedTabsDropdown />);
    fireEvent.click(screen.getByLabelText('已关闭的工作空间'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByLabelText('已关闭的工作空间')).toHaveAttribute('aria-expanded', 'false');
  });

  it('点击外部关闭菜单', () => {
    useWorkspaceStore.setState({ closedIds: [WS_B.id] });
    render(<ClosedTabsDropdown />);
    fireEvent.click(screen.getByLabelText('已关闭的工作空间'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
