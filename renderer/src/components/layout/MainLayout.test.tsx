// renderer/src/components/layout/MainLayout.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MainLayout } from './MainLayout';
import { useUiStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { Workspace } from '../../ipc/types';

// 测试用 workspace 桩数据
const STUB_WORKSPACE: Workspace = {
  id: 'ws-test',
  name: 'Test',
  description: '',
  directoryPath: '/tmp/test',
  matrixSpaceId: '!space:test',
  gitInitialized: false,
  createdAt: '2026-01-01T00:00:00Z',
  ownerId: 'owner',
  iconEmoji: '📁',
};

describe('MainLayout', () => {
  beforeEach(() => {
    // 重置两个 store，保证测试间状态确定
    useUiStore.setState({ activeView: 'im' });
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      loading: false,
      error: null,
    });
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

  it('shows "Coming in M1+" placeholder for IM view when a workspace is active', () => {
    useWorkspaceStore.setState({
      workspaces: [STUB_WORKSPACE],
      activeWorkspaceId: STUB_WORKSPACE.id,
    });
    render(<MainLayout />);
    expect(screen.getByText(/coming in m1/i)).toBeInTheDocument();
  });
});
