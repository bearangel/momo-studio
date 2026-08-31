// renderer/src/stores/workspace.store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWorkspaceStore } from './workspace.store';
import type { Workspace } from '../ipc/types';

const MOCK_WS: Workspace = {
  id: 'ws-1',
  name: '测试工作区',
  description: '',
  directoryPath: '/tmp/ws-1',
  gitInitialized: true,
  createdAt: '2026-01-01T00:00:00Z',
  ownerId: '@owner:localhost',
  iconEmoji: '🧪',
  defaultAgentInstanceId: null,
};

// 设为协调后刷新返回的列表：defaultAgentInstanceId 已更新
const MOCK_WS_AFTER_SET: Workspace = { ...MOCK_WS, defaultAgentInstanceId: 'inst-1' };

const MOCK_WS_2: Workspace = { ...MOCK_WS, id: 'ws-2', name: '第二个工作区' };

const mockApi = {
  workspace: {
    list: vi.fn().mockResolvedValue([MOCK_WS]),
    setDefaultAgent: vi.fn().mockResolvedValue({ ok: true }),
    delete: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue({ ok: true }),
  },
};

beforeEach(() => {
  Object.assign(globalThis, { window: { api: mockApi } });
  // 重置 store 状态，保证测试间隔离
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, error: null });
  mockApi.workspace.list.mockResolvedValue([MOCK_WS]);
  mockApi.workspace.setDefaultAgent.mockResolvedValue({ ok: true });
  mockApi.workspace.setDefaultAgent.mockClear();
  mockApi.workspace.list.mockClear();
  mockApi.workspace.delete.mockResolvedValue(undefined);
  mockApi.workspace.delete.mockClear();
  mockApi.workspace.rename.mockResolvedValue({ ok: true });
  mockApi.workspace.rename.mockClear();
});

describe('workspace.store', () => {
  it('setDefaultAgent 调用 ipc 并刷新 workspaces', async () => {
    // 刷新时返回已更新协调身份的列表
    mockApi.workspace.list.mockResolvedValue([MOCK_WS_AFTER_SET]);

    await useWorkspaceStore.getState().setDefaultAgent('ws-1', 'inst-1');

    expect(mockApi.workspace.setDefaultAgent).toHaveBeenCalledWith('ws-1', 'inst-1');
    expect(mockApi.workspace.list).toHaveBeenCalled();
    expect(useWorkspaceStore.getState().workspaces).toEqual([MOCK_WS_AFTER_SET]);
  });

  it('setDefaultAgent 传 null 取消协调', async () => {
    await useWorkspaceStore.getState().setDefaultAgent('ws-1', null);

    expect(mockApi.workspace.setDefaultAgent).toHaveBeenCalledWith('ws-1', null);
  });

  it('setDefaultAgent IPC 失败时抛错并写入 error', async () => {
    const error = new Error('设置协调失败');
    mockApi.workspace.setDefaultAgent.mockRejectedValue(error);

    await expect(useWorkspaceStore.getState().setDefaultAgent('ws-1', 'inst-1')).rejects.toBe(
      error,
    );
    expect(useWorkspaceStore.getState().error).toBe('设置协调失败');
    expect(mockApi.workspace.list).not.toHaveBeenCalled();
  });

  it('setDefaultAgent 刷新列表失败时抛错并写入 error', async () => {
    const error = new Error('刷新工作区失败');
    mockApi.workspace.list.mockRejectedValue(error);

    await expect(useWorkspaceStore.getState().setDefaultAgent('ws-1', 'inst-1')).rejects.toBe(
      error,
    );
    expect(mockApi.workspace.setDefaultAgent).toHaveBeenCalledWith('ws-1', 'inst-1');
    expect(useWorkspaceStore.getState().error).toBe('刷新工作区失败');
  });

  it('setDefaultAgent 成功前清除旧 error', async () => {
    useWorkspaceStore.setState({ error: '旧错误' });

    await useWorkspaceStore.getState().setDefaultAgent('ws-1', 'inst-1');

    expect(useWorkspaceStore.getState().error).toBeNull();
  });
});

describe('workspace.store remove/rename（P2 Task 2）', () => {
  it('remove 调用 ipc.workspace.delete 后刷新列表', async () => {
    useWorkspaceStore.setState({ workspaces: [MOCK_WS, MOCK_WS_2], activeWorkspaceId: 'ws-1' });
    mockApi.workspace.list.mockResolvedValue([MOCK_WS_2]);

    await useWorkspaceStore.getState().remove('ws-1');

    expect(mockApi.workspace.delete).toHaveBeenCalledWith('ws-1');
    expect(useWorkspaceStore.getState().workspaces).toEqual([MOCK_WS_2]);
  });

  it('remove 失败时抛错并写入 error，不刷新列表', async () => {
    mockApi.workspace.delete.mockRejectedValue(new Error('删除失败'));

    await expect(useWorkspaceStore.getState().remove('ws-1')).rejects.toThrow('删除失败');

    expect(useWorkspaceStore.getState().error).toBe('删除失败');
    expect(mockApi.workspace.list).not.toHaveBeenCalled();
  });

  it('rename 调用 ipc.workspace.rename 并本地同步名称', async () => {
    useWorkspaceStore.setState({ workspaces: [MOCK_WS], activeWorkspaceId: 'ws-1' });

    await useWorkspaceStore.getState().rename('ws-1', '新名字');

    expect(mockApi.workspace.rename).toHaveBeenCalledWith('ws-1', '新名字');
    expect(useWorkspaceStore.getState().workspaces[0]!.name).toBe('新名字');
  });

  it('rename 失败时抛错并写入 error，名称不变', async () => {
    useWorkspaceStore.setState({ workspaces: [MOCK_WS], activeWorkspaceId: 'ws-1' });
    mockApi.workspace.rename.mockRejectedValue(new Error('重命名失败'));

    await expect(useWorkspaceStore.getState().rename('ws-1', 'X')).rejects.toThrow('重命名失败');

    expect(useWorkspaceStore.getState().error).toBe('重命名失败');
    expect(useWorkspaceStore.getState().workspaces[0]!.name).toBe('测试工作区');
  });
});
