// renderer/src/stores/workspace.store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWorkspaceStore } from './workspace.store';
import type { Workspace } from '../ipc/types';

const MOCK_WS: Workspace = {
  id: 'ws-1',
  name: '测试工作区',
  description: '',
  directoryPath: '/tmp/ws-1',
  matrixSpaceId: '!space:localhost',
  teamRoomId: '!team:localhost',
  gitInitialized: true,
  createdAt: '2026-01-01T00:00:00Z',
  ownerId: '@owner:localhost',
  iconEmoji: '🧪',
  coordinatorInstanceId: null,
};

// 设为协调后刷新返回的列表：coordinatorInstanceId 已更新
const MOCK_WS_AFTER_SET: Workspace = { ...MOCK_WS, coordinatorInstanceId: 'inst-1' };

const mockApi = {
  workspace: {
    list: vi.fn().mockResolvedValue([MOCK_WS]),
    setCoordinator: vi.fn().mockResolvedValue({ ok: true }),
  },
};

beforeEach(() => {
  Object.assign(globalThis, { window: { api: mockApi } });
  // 重置 store 状态，保证测试间隔离
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, error: null });
  mockApi.workspace.list.mockResolvedValue([MOCK_WS]);
  mockApi.workspace.setCoordinator.mockResolvedValue({ ok: true });
  mockApi.workspace.setCoordinator.mockClear();
  mockApi.workspace.list.mockClear();
});

describe('workspace.store', () => {
  it('setCoordinator 调用 ipc 并刷新 workspaces', async () => {
    // 刷新时返回已更新协调身份的列表
    mockApi.workspace.list.mockResolvedValue([MOCK_WS_AFTER_SET]);

    await useWorkspaceStore.getState().setCoordinator('ws-1', 'inst-1');

    expect(mockApi.workspace.setCoordinator).toHaveBeenCalledWith('ws-1', 'inst-1');
    expect(mockApi.workspace.list).toHaveBeenCalled();
    expect(useWorkspaceStore.getState().workspaces).toEqual([MOCK_WS_AFTER_SET]);
  });

  it('setCoordinator 传 null 取消协调', async () => {
    await useWorkspaceStore.getState().setCoordinator('ws-1', null);

    expect(mockApi.workspace.setCoordinator).toHaveBeenCalledWith('ws-1', null);
  });

  it('setCoordinator IPC 失败时抛错并写入 error', async () => {
    const error = new Error('设置协调失败');
    mockApi.workspace.setCoordinator.mockRejectedValue(error);

    await expect(useWorkspaceStore.getState().setCoordinator('ws-1', 'inst-1')).rejects.toBe(
      error,
    );
    expect(useWorkspaceStore.getState().error).toBe('设置协调失败');
    expect(mockApi.workspace.list).not.toHaveBeenCalled();
  });

  it('setCoordinator 刷新列表失败时抛错并写入 error', async () => {
    const error = new Error('刷新工作区失败');
    mockApi.workspace.list.mockRejectedValue(error);

    await expect(useWorkspaceStore.getState().setCoordinator('ws-1', 'inst-1')).rejects.toBe(
      error,
    );
    expect(useWorkspaceStore.getState().error).toBe('刷新工作区失败');
  });

  it('setCoordinator 成功前清除旧 error', async () => {
    useWorkspaceStore.setState({ error: '旧错误' });

    await useWorkspaceStore.getState().setCoordinator('ws-1', 'inst-1');

    expect(useWorkspaceStore.getState().error).toBeNull();
  });
});
