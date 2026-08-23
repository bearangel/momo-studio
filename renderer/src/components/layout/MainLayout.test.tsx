// renderer/src/components/layout/MainLayout.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MainLayout } from './MainLayout';
import { useUiStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSessionStore } from '../../stores/session.store';
import type { Workspace } from '../../ipc/types';

// 测试用 workspace 桩数据
const STUB_WORKSPACE: Workspace = {
  id: 'ws-test',
  name: 'Test',
  description: '',
  directoryPath: '/tmp/test',
  teamSessionId: 'sess-team',
  gitInitialized: false,
  createdAt: '2026-01-01T00:00:00Z',
  ownerId: 'owner',
  iconEmoji: '📁',
  coordinatorInstanceId: null,
};

// MainLayout 的 useEffect 会调用 session.list（首屏拉取）+ agent.onRuntimeChanged，
// 必须提供桩 window.api，否则渲染时抛错。
// v2.0 P1 Task 9：无 im.startSync 步骤（会话内核纯 SQLite）。
// v2.0 P2 Task 2：ConflictDialogMount 上移到 MainShell，im.onConflict 不再由本组件订阅。
const mockApi = {
  session: {
    list: vi.fn().mockResolvedValue([]),
  },
  agent: {
    onRuntimeChanged: vi.fn().mockReturnValue(() => {}),
    isRunning: vi.fn().mockResolvedValue(false),
  },
};

describe('MainLayout', () => {
  beforeEach(() => {
    // 只设置 api，不替换整个 window（保留 jsdom Window 的其它属性与方法）
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    // 重置三个 store，保证测试间状态确定
    useUiStore.setState({ activeView: 'im' });
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      loading: false,
      error: null,
    });
    useSessionStore.getState().reset();
    mockApi.session.list.mockResolvedValue([]);
  });

  it('renders left rail with all 5 nav icons', () => {
    render(<MainLayout />);
    expect(screen.getByLabelText('View: IM')).toBeInTheDocument();
    expect(screen.getByLabelText('View: Files')).toBeInTheDocument();
    expect(screen.getByLabelText('View: Agents')).toBeInTheDocument();
    expect(screen.getByLabelText('View: 资源库')).toBeInTheDocument();
    expect(screen.getByLabelText('View: Settings')).toBeInTheDocument();
  });

  it('clicking nav icon switches active view', () => {
    render(<MainLayout />);
    fireEvent.click(screen.getByLabelText('View: Settings'));
    expect(useUiStore.getState().activeView).toBe('settings');
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
});
