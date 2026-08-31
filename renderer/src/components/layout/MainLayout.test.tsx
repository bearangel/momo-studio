// renderer/src/components/layout/MainLayout.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MainLayout } from './MainLayout';
import { useUiStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSessionStore } from '../../stores/session.store';
import { useTaskStore } from '../../stores/task.store';
import { useAgentStore } from '../../stores/agent.store';
import type { Workspace } from '../../ipc/types';

// 测试用 workspace 桩数据
const STUB_WORKSPACE: Workspace = {
  id: 'ws-test',
  name: 'Test',
  description: '',
  directoryPath: '/tmp/test',
  gitInitialized: false,
  createdAt: '2026-01-01T00:00:00Z',
  ownerId: 'owner',
  iconEmoji: '📁',
  defaultAgentInstanceId: null,
};

const STUB_WORKSPACE_2: Workspace = {
  ...STUB_WORKSPACE,
  id: 'ws-test-2',
  name: 'Test 2',
};

// MainLayout 的 useEffect 会调用 session.list（首屏拉取）+ agent.onRuntimeChanged，
// 必须提供桩 window.api，否则渲染时抛错。
// v2.0 P1 Task 9：无 im.startSync 步骤（会话内核纯 SQLite）。
// v2.0 P2 Task 3：LeftRail → ActivityBar + ViewSidebar；task.list 供看板轮询。
const mockApi = {
  session: {
    list: vi.fn().mockResolvedValue([]),
  },
  agent: {
    onRuntimeChanged: vi.fn().mockReturnValue(() => {}),
    isRunning: vi.fn().mockResolvedValue(false),
    listMembers: vi.fn().mockResolvedValue([]),
  },
  task: {
    list: vi.fn().mockResolvedValue([]),
  },
};

describe('MainLayout', () => {
  beforeEach(() => {
    // 只设置 api，不替换整个 window（保留 jsdom Window 的其它属性与方法）
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    // 重置 store，保证测试间状态确定
    useUiStore.setState({ activeView: 'im', sidebarCollapsed: false });
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      loading: false,
      error: null,
    });
    useSessionStore.getState().reset();
    useTaskStore.getState().reset();
    useAgentStore.getState().reset();
    mockApi.session.list.mockReset();
    mockApi.session.list.mockResolvedValue([]);
    mockApi.agent.listMembers.mockReset();
    mockApi.agent.listMembers.mockResolvedValue([]);
    mockApi.agent.onRuntimeChanged.mockReset();
    mockApi.agent.onRuntimeChanged.mockReturnValue(() => {});
  });

  it('渲染活动栏 5 主项 + 底部设置项', () => {
    render(<MainLayout />);
    expect(screen.getByLabelText('会话')).toBeInTheDocument();
    expect(screen.getByLabelText('文件')).toBeInTheDocument();
    expect(screen.getByLabelText('看板')).toBeInTheDocument();
    expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    expect(screen.getByLabelText('资源库')).toBeInTheDocument();
    expect(screen.getByLabelText('设置')).toBeInTheDocument();
  });

  it('点击活动项切换 activeView', () => {
    render(<MainLayout />);
    fireEvent.click(screen.getByLabelText('设置'));
    expect(useUiStore.getState().activeView).toBe('settings');
  });

  it('Ctrl/Cmd+B 全局快捷键切换侧边栏折叠', () => {
    render(<MainLayout />);
    // Ctrl+B（linux/win）
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    // Cmd+B（mac）
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('Ctrl+B 事件被 preventDefault（不触发浏览器默认行为）', () => {
    render(<MainLayout />);
    // fireEvent 在 defaultPrevented 时返回 false
    const evt = fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(evt).toBe(false);
  });

  it('无修饰键的 b 键不切换侧边栏', () => {
    render(<MainLayout />);
    fireEvent.keyDown(window, { key: 'b' });
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('shows workspace prompt when no workspace is active', () => {
    render(<MainLayout />);
    expect(
      screen.getByText(/创建或选择一个工作空间开始/i),
    ).toBeInTheDocument();
  });

  it('shows IM room list when IM view is active with a workspace', () => {
    useWorkspaceStore.setState({
      workspaces: [STUB_WORKSPACE],
      activeWorkspaceId: STUB_WORKSPACE.id,
    });
    render(<MainLayout />);
    expect(screen.getByText(/暂无房间|加载中/i)).toBeInTheDocument();
  });

  it('挂载时触发 session.list 首屏拉取（无 im.startSync）', () => {
    render(<MainLayout />);
    expect(mockApi.session.list).toHaveBeenCalled();
  });

  // 邀请列表冷启动回归锁（fix #4，commit 3545e97）
  it('挂载时主动 loadAssignments(activeWorkspaceId)（邀请列表冷启动）', async () => {
    useWorkspaceStore.setState({
      workspaces: [STUB_WORKSPACE],
      activeWorkspaceId: STUB_WORKSPACE.id,
    });
    render(<MainLayout />);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApi.agent.listMembers).toHaveBeenCalledWith(STUB_WORKSPACE.id);
  });

  it('activeWorkspaceId 为 null 时不触发 loadAssignments（IPC 保持未调）', async () => {
    render(<MainLayout />);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApi.agent.listMembers).not.toHaveBeenCalled();
  });

  it('activeWorkspaceId 从 null 切到 ws 时触发 loadAssignments（邀请列表补齐）', async () => {
    const { rerender } = render(<MainLayout />);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApi.agent.listMembers).not.toHaveBeenCalled();

    useWorkspaceStore.setState({
      workspaces: [STUB_WORKSPACE],
      activeWorkspaceId: STUB_WORKSPACE.id,
    });
    rerender(<MainLayout />);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApi.agent.listMembers).toHaveBeenCalledWith(STUB_WORKSPACE.id);
  });

  it('activeWorkspaceId 从 ws-a 切到 ws-b 时重新 loadAssignments（保证新 ws 邀请列表正确）', async () => {
    useWorkspaceStore.setState({
      workspaces: [STUB_WORKSPACE, STUB_WORKSPACE_2],
      activeWorkspaceId: STUB_WORKSPACE.id,
    });
    const { rerender } = render(<MainLayout />);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApi.agent.listMembers).toHaveBeenCalledTimes(1);
    expect(mockApi.agent.listMembers).toHaveBeenLastCalledWith(STUB_WORKSPACE.id);

    useWorkspaceStore.setState({ activeWorkspaceId: STUB_WORKSPACE_2.id });
    rerender(<MainLayout />);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApi.agent.listMembers).toHaveBeenCalledTimes(2);
    expect(mockApi.agent.listMembers).toHaveBeenLastCalledWith(STUB_WORKSPACE_2.id);
  });
});

describe('MainLayout — loadAssignments 冷启动（邀请列表回归锁）', () => {
  beforeEach(() => {
    // 显式清零：避免前序测试残留的 listMembers 调用记录污染断言
    mockApi.agent.listMembers.mockClear();
  });

  it('挂载时若 activeWorkspaceId 存在则调用 listMembers(activeWorkspaceId)（邀请列表冷启动）', async () => {
    useWorkspaceStore.setState({
      workspaces: [STUB_WORKSPACE],
      activeWorkspaceId: STUB_WORKSPACE.id,
    });
    render(<MainLayout />);
    // useEffect 在 render 后异步触发，flush 微任务等待 ipc 调用落定
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApi.agent.listMembers).toHaveBeenCalledWith(STUB_WORKSPACE.id);
  });

  it('activeWorkspaceId 从无到有时补调一次 listMembers（切到第一个 workspace）', async () => {
    useWorkspaceStore.setState({ activeWorkspaceId: null });
    render(<MainLayout />);
    await new Promise((r) => setTimeout(r, 0));
    // 没 workspace 时 effect 体里 `if (activeWorkspaceId)` 短路，不发 IPC
    expect(mockApi.agent.listMembers).not.toHaveBeenCalled();

    // 切到工作空间：zustand 订阅触发 re-render，useEffect 重新评估并调用 IPC
    useWorkspaceStore.setState({ activeWorkspaceId: STUB_WORKSPACE.id });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApi.agent.listMembers).toHaveBeenCalledWith(STUB_WORKSPACE.id);
  });

  it('activeWorkspaceId 变化时重新调用 listMembers（切工作空间刷新邀请列表）', async () => {
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' });
    render(<MainLayout />);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApi.agent.listMembers).toHaveBeenCalledTimes(1);
    expect(mockApi.agent.listMembers).toHaveBeenCalledWith('ws-a');

    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-b' });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApi.agent.listMembers).toHaveBeenCalledTimes(2);
    expect(mockApi.agent.listMembers).toHaveBeenLastCalledWith('ws-b');
  });

  it('activeWorkspaceId 为 null 时不调用 listMembers（无工作空间不触发）', async () => {
    useWorkspaceStore.setState({ activeWorkspaceId: null });
    render(<MainLayout />);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApi.agent.listMembers).not.toHaveBeenCalled();
  });
});
