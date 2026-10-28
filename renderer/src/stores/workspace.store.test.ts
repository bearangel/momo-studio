// renderer/src/stores/workspace.store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWorkspaceStore, subscribeWorkspaceListChanged } from './workspace.store';
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

// 镜像落地的新空间（M2.1 D3 推送对账用例——主进程侧落库、renderer 无感知）
const MOCK_WS_MIRRORED: Workspace = { ...MOCK_WS, id: 'ws-mirror', name: 'dev-ws' };

// D3：listChanged 推送捕获面（subscribeWorkspaceListChanged 契约）
let listChangedCb: ((e: { reason: string; workspaceName?: string }) => void) | null = null;

const mockApi = {
  workspace: {
    list: vi.fn().mockResolvedValue([MOCK_WS]),
    create: vi.fn().mockResolvedValue(MOCK_WS_2),
    setDefaultAgent: vi.fn().mockResolvedValue({ ok: true }),
    delete: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue({ ok: true }),
    switch: vi.fn().mockResolvedValue({ ok: true }),
    onListChanged: vi.fn((cb: (e: { reason: string; workspaceName?: string }) => void) => {
      listChangedCb = cb;
      return () => {
        listChangedCb = null;
      };
    }),
  },
};

beforeEach(() => {
  Object.assign(globalThis, { window: { api: mockApi } });
  // 持久化用例先例（theme.store）：每个用例前清空 localStorage，隔离持久键
  localStorage.clear();
  // 重置 store 状态，保证测试间隔离（closedIds 会话级状态一并复位）
  useWorkspaceStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    closedIds: [],
    error: null,
  });
  mockApi.workspace.list.mockResolvedValue([MOCK_WS]);
  mockApi.workspace.create.mockResolvedValue(MOCK_WS_2);
  mockApi.workspace.setDefaultAgent.mockResolvedValue({ ok: true });
  mockApi.workspace.list.mockClear();
  mockApi.workspace.setDefaultAgent.mockClear();
  mockApi.workspace.delete.mockResolvedValue(undefined);
  mockApi.workspace.delete.mockClear();
  mockApi.workspace.rename.mockResolvedValue({ ok: true });
  mockApi.workspace.rename.mockClear();
  mockApi.workspace.switch.mockResolvedValue({ ok: true });
  mockApi.workspace.switch.mockClear();
  listChangedCb = null;
  mockApi.workspace.onListChanged.mockClear();
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

describe('workspace.store closeTab/reopenTab（D6 关标签 ≠ 删除）', () => {
  it('closeTab 把 id 加入 closedIds，不调 ipc.workspace.delete', () => {
    useWorkspaceStore.setState({ workspaces: [MOCK_WS, MOCK_WS_2], activeWorkspaceId: 'ws-1' });

    useWorkspaceStore.getState().closeTab('ws-1');

    expect(useWorkspaceStore.getState().closedIds).toEqual(['ws-1']);
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(2);
    expect(mockApi.workspace.delete).not.toHaveBeenCalled();
  });

  it('closeTab 关闭激活项 → active 切到剩余可见首个，并按 select 语义持久化 + 通知 main', () => {
    useWorkspaceStore.setState({ workspaces: [MOCK_WS, MOCK_WS_2], activeWorkspaceId: 'ws-1' });

    useWorkspaceStore.getState().closeTab('ws-1');

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');
    expect(localStorage.getItem('momo.activeWorkspace')).toBe('ws-2');
    expect(mockApi.workspace.switch).toHaveBeenCalledWith('ws-2');
  });

  it('closeTab 关闭非激活项 → active 不变、不触发切换通知', () => {
    useWorkspaceStore.setState({ workspaces: [MOCK_WS, MOCK_WS_2], activeWorkspaceId: 'ws-1' });

    useWorkspaceStore.getState().closeTab('ws-2');

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-1');
    expect(mockApi.workspace.switch).not.toHaveBeenCalled();
  });

  it('closeTab 关闭到全部不可见 → active 置 null，但持久键保留（重启恢复的依据）', () => {
    useWorkspaceStore.setState({ workspaces: [MOCK_WS], activeWorkspaceId: 'ws-1' });
    localStorage.setItem('momo.activeWorkspace', 'ws-1');

    useWorkspaceStore.getState().closeTab('ws-1');

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
    expect(useWorkspaceStore.getState().closedIds).toEqual(['ws-1']);
    expect(localStorage.getItem('momo.activeWorkspace')).toBe('ws-1');
  });

  it('closeTab 对未知 id / 已关闭 id 幂等 no-op（错误路径）', () => {
    useWorkspaceStore.setState({ workspaces: [MOCK_WS], activeWorkspaceId: 'ws-1', closedIds: ['ws-2'] });

    useWorkspaceStore.getState().closeTab('ws-gone');
    useWorkspaceStore.getState().closeTab('ws-2');

    expect(useWorkspaceStore.getState().closedIds).toEqual(['ws-2']);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-1');
  });

  it('reopenTab 移出 closedIds 并激活（含持久化 + 通知）', () => {
    useWorkspaceStore.setState({
      workspaces: [MOCK_WS, MOCK_WS_2],
      activeWorkspaceId: 'ws-1',
      closedIds: ['ws-2'],
    });

    useWorkspaceStore.getState().reopenTab('ws-2');

    expect(useWorkspaceStore.getState().closedIds).toEqual([]);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');
    expect(localStorage.getItem('momo.activeWorkspace')).toBe('ws-2');
    expect(mockApi.workspace.switch).toHaveBeenCalledWith('ws-2');
  });

  it('remove 真删 workspace 后同步清理 closedIds 中的死 id', async () => {
    useWorkspaceStore.setState({
      workspaces: [MOCK_WS, MOCK_WS_2],
      activeWorkspaceId: 'ws-1',
      closedIds: ['ws-1'],
    });
    mockApi.workspace.list.mockResolvedValue([MOCK_WS_2]);

    await useWorkspaceStore.getState().remove('ws-1');

    expect(useWorkspaceStore.getState().closedIds).toEqual([]);
  });
});

describe('workspace.store 激活切换通知（v2.7 T10 workspace:switch）', () => {
  it('load 默认激活首项后通知 main（初始激活的 renderer 侧来源）', async () => {
    await useWorkspaceStore.getState().load();
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-1');
    expect(mockApi.workspace.switch).toHaveBeenCalledWith('ws-1');
  });

  it('load 空列表不通知（无激活项）', async () => {
    mockApi.workspace.list.mockResolvedValue([]);
    await useWorkspaceStore.getState().load();
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
    expect(mockApi.workspace.switch).not.toHaveBeenCalled();
  });

  it('select 切换激活后通知 main', () => {
    useWorkspaceStore.setState({ workspaces: [MOCK_WS, MOCK_WS_2], activeWorkspaceId: 'ws-1' });

    useWorkspaceStore.getState().select('ws-2');

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');
    expect(mockApi.workspace.switch).toHaveBeenCalledWith('ws-2');
  });

  it('create 新建即激活并通知 main', async () => {
    await useWorkspaceStore.getState().create({
      name: '第二个工作区',
      directoryPath: '/tmp/ws-2',
    });

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');
    expect(mockApi.workspace.switch).toHaveBeenCalledWith('ws-2');
  });

  it('switch 通知失败不阻塞本地激活（fire-and-forget 旁路）', () => {
    mockApi.workspace.switch.mockRejectedValue(new Error('IPC 故障'));
    useWorkspaceStore.setState({ workspaces: [MOCK_WS, MOCK_WS_2], activeWorkspaceId: 'ws-1' });

    useWorkspaceStore.getState().select('ws-2');

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');
  });
});

describe('workspace.store 上次活跃持久化（重启恢复回归锁）', () => {
  it('load 恢复持久化的上次活跃 workspace（持久 id 命中列表）', async () => {
    mockApi.workspace.list.mockResolvedValue([MOCK_WS, MOCK_WS_2]);
    localStorage.setItem('momo.activeWorkspace', 'ws-2');

    await useWorkspaceStore.getState().load();

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');
  });

  it('load 持久 id 已被删（不在列表）时回退列表首项并更新持久键', async () => {
    // 列表首项为 ws-2（main 侧 ORDER BY created_at DESC），持久 id 已失效
    mockApi.workspace.list.mockResolvedValue([MOCK_WS_2, MOCK_WS]);
    localStorage.setItem('momo.activeWorkspace', 'ws-gone');

    await useWorkspaceStore.getState().load();

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');
    expect(localStorage.getItem('momo.activeWorkspace')).toBe('ws-2');
  });

  it('load 无持久值时激活列表首项并写入持久键', async () => {
    mockApi.workspace.list.mockResolvedValue([MOCK_WS, MOCK_WS_2]);

    await useWorkspaceStore.getState().load();

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-1');
    expect(localStorage.getItem('momo.activeWorkspace')).toBe('ws-1');
  });

  it('select 切换后写入持久键（下次启动恢复依据）', () => {
    useWorkspaceStore.setState({ workspaces: [MOCK_WS, MOCK_WS_2], activeWorkspaceId: 'ws-1' });

    useWorkspaceStore.getState().select('ws-2');

    expect(localStorage.getItem('momo.activeWorkspace')).toBe('ws-2');
  });

  it('create 新建即激活并写入持久键', async () => {
    await useWorkspaceStore.getState().create({
      name: '第二个工作区',
      directoryPath: '/tmp/ws-2',
    });

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');
    expect(localStorage.getItem('momo.activeWorkspace')).toBe('ws-2');
  });

  it('remove 删除激活项后持久键随 load 回退结果更新', async () => {
    useWorkspaceStore.setState({ workspaces: [MOCK_WS, MOCK_WS_2], activeWorkspaceId: 'ws-1' });
    localStorage.setItem('momo.activeWorkspace', 'ws-1');
    mockApi.workspace.list.mockResolvedValue([MOCK_WS_2]);

    await useWorkspaceStore.getState().remove('ws-1');

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');
    expect(localStorage.getItem('momo.activeWorkspace')).toBe('ws-2');
  });
});

describe('workspace.store subscribeWorkspaceListChanged（M2.1 D3：镜像落地对账）', () => {
  it('推送到达 → load 重拉，镜像新空间入列表并成为激活（0-ws 冷启动翻转）', async () => {
    mockApi.workspace.list.mockResolvedValueOnce([]); // 初始 0-ws
    await useWorkspaceStore.getState().load();
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(0);

    // 主进程侧镜像落地 dev-ws（renderer 无感知）——推送后下一次 list 可见
    mockApi.workspace.list.mockResolvedValue([MOCK_WS_MIRRORED]);
    const dispose = subscribeWorkspaceListChanged();
    listChangedCb!({ reason: 'mirror-applied', workspaceName: 'dev-ws' });

    await vi.waitFor(() => {
      expect(useWorkspaceStore.getState().workspaces.map((w) => w.name)).toEqual(['dev-ws']);
    });
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-mirror');
    dispose();
  });

  it('已有激活空间时推送不夺激活（持久键恢复语义）', async () => {
    mockApi.workspace.list.mockResolvedValueOnce([MOCK_WS]);
    await useWorkspaceStore.getState().load();
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-1');

    mockApi.workspace.list.mockResolvedValue([MOCK_WS_MIRRORED, MOCK_WS]);
    const dispose = subscribeWorkspaceListChanged();
    listChangedCb!({ reason: 'mirror-applied', workspaceName: 'dev-ws' });

    await vi.waitFor(() => {
      expect(useWorkspaceStore.getState().workspaces).toHaveLength(2);
    });
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-1');
    dispose();
  });

  it('退订后回调清空——推送面断开', async () => {
    const dispose = subscribeWorkspaceListChanged();
    expect(listChangedCb).not.toBeNull();
    dispose();
    expect(listChangedCb).toBeNull();
  });
});

describe('workspace.store load() 保 active 守卫（M2.3 T5 件7，T4 排查 P-A/P-C）', () => {
  it('P-A 复活路径锁：全关 → active=null → listChanged 重拉 → 不从持久键复活已关闭空间', async () => {
    // 两空间均可见，激活 ws-1；关 ws-1 时切 ws-2 落盘，全关后持久键残留 ws-2
    mockApi.workspace.list.mockResolvedValue([MOCK_WS, MOCK_WS_2]);
    await useWorkspaceStore.getState().load();
    useWorkspaceStore.getState().closeTab('ws-1');
    useWorkspaceStore.getState().closeTab('ws-2');
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
    expect(localStorage.getItem('momo.activeWorkspace')).toBe('ws-2');

    // 镜像应用等触发的 listChanged → load 重拉（列表仍含两空间）
    const dispose = subscribeWorkspaceListChanged();
    listChangedCb!({ reason: 'mirror-applied', workspaceName: 'dev-ws' });

    await vi.waitFor(() => {
      expect(mockApi.workspace.list).toHaveBeenCalledTimes(2);
    });
    // 修复前：persisted=ws-2 命中列表 → 已关闭空间复活（closedIds 残留 → tab 不可见撕裂）
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
    expect(useWorkspaceStore.getState().closedIds).toEqual(['ws-1', 'ws-2']);
    // 持久键不动（无激活不落盘）——下次启动仍可按原语义恢复
    expect(localStorage.getItem('momo.activeWorkspace')).toBe('ws-2');
    dispose();
  });

  it('notifySwitch 不重放：内存激活值仍在列表的 load 不再向 main 重放 switch', async () => {
    // boot：恢复 persisted=ws-2，switch 通知恰好 1 次
    mockApi.workspace.list.mockResolvedValue([MOCK_WS, MOCK_WS_2]);
    localStorage.setItem('momo.activeWorkspace', 'ws-2');
    await useWorkspaceStore.getState().load();
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');
    expect(mockApi.workspace.switch).toHaveBeenCalledTimes(1);

    // listChanged 重拉（active 未变）：不重放 notifySwitch（修复前 main 单点被无条件重播）
    const dispose = subscribeWorkspaceListChanged();
    listChangedCb!({ reason: 'mirror-applied', workspaceName: 'dev-ws' });
    await vi.waitFor(() => {
      expect(mockApi.workspace.list).toHaveBeenCalledTimes(2);
    });
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');
    expect(mockApi.workspace.switch).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('persisted 失效回退不夺内存值：持久键指向已删空间而内存激活仍在列表 → 保持内存值（不回退 list[0]）', async () => {
    mockApi.workspace.list.mockResolvedValue([MOCK_WS, MOCK_WS_2]);
    localStorage.setItem('momo.activeWorkspace', 'ws-2');
    await useWorkspaceStore.getState().load();
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');

    // 持久键失效（指向已删空间），重拉列表首项为 ws-1——内存值 ws-2 胜出
    localStorage.setItem('momo.activeWorkspace', 'ws-gone');
    await useWorkspaceStore.getState().load();

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');
  });

  it('boot 恢复语义不回归：内存 null + 空列表的首次 load 仍恢复持久键并通知 main', async () => {
    mockApi.workspace.list.mockResolvedValue([MOCK_WS, MOCK_WS_2]);
    localStorage.setItem('momo.activeWorkspace', 'ws-2');

    await useWorkspaceStore.getState().load();

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-2');
    expect(mockApi.workspace.switch).toHaveBeenCalledWith('ws-2');
  });
});
