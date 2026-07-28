// renderer/src/components/layout/MainLayout.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MainLayout } from './MainLayout';
import { useUiStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useImStore } from '../../stores/im.store';
import type { Workspace } from '../../ipc/types';

// 测试用 workspace 桩数据
const STUB_WORKSPACE: Workspace = {
  id: 'ws-test',
  name: 'Test',
  description: '',
  directoryPath: '/tmp/test',
  matrixSpaceId: '!space:test',
  teamRoomId: '!team:test',
  gitInitialized: false,
  createdAt: '2026-01-01T00:00:00Z',
  ownerId: 'owner',
  iconEmoji: '📁',
};

// MainLayout 的 useEffect 会调用 ipc.im.startSync / onMessage / loadRooms(getRooms)，
// 必须提供桩 window.api，否则渲染时抛错。
const mockApi = {
  im: {
    startSync: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    getRooms: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
    onMessage: vi.fn().mockReturnValue(() => {}),
  },
};

describe('MainLayout', () => {
  beforeEach(() => {
    Object.assign(globalThis, { window: { api: mockApi } });
    // 重置三个 store，保证测试间状态确定
    useUiStore.setState({ activeView: 'im' });
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      loading: false,
      error: null,
    });
    useImStore.getState().reset();
    // startSync 返回永不 resolve 的 promise，防止 useEffect 异步链触发 store 状态更新
    // 导致 act() 冲突——布局测试不验证 IM 同步行为（由 im.store.test.ts 覆盖）
    mockApi.im.startSync.mockImplementation(() => new Promise(() => {}));
    mockApi.im.getRooms.mockResolvedValue([]);
  });

  it('renders left rail with all 5 nav icons', () => {
    render(<MainLayout />);
    expect(screen.getByLabelText('View: IM')).toBeInTheDocument();
    expect(screen.getByLabelText('View: Files')).toBeInTheDocument();
    expect(screen.getByLabelText('View: Agents')).toBeInTheDocument();
    expect(screen.getByLabelText('View: Marketplace')).toBeInTheDocument();
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
      screen.getByText(/创建或选择一个 workspace 开始/i),
    ).toBeInTheDocument();
  });

  it('shows IM room list when IM view is active with a workspace', () => {
    useWorkspaceStore.setState({
      workspaces: [STUB_WORKSPACE],
      activeWorkspaceId: STUB_WORKSPACE.id,
    });
    render(<MainLayout />);
    expect(screen.getByText(/暂无房间/i)).toBeInTheDocument();
  });
});
