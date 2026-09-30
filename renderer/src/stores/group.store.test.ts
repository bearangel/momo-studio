// renderer/src/stores/group.store.test.ts
//
// group.store 用例（看板重构 Task 10）：
//   - load：list 拉活跃组（默认 'exclude'）写入 store；失败记 error
//   - create/rename/setColor/reorder/archive/unarchive：全部 await ipc.taskGroup.*
//     后本地同步——追加/用返回行替换/镜像 repo 排序语义/剔除/按 position 塞回
//   - 动作失败一律 rethrow 且本地不动（错误路径专项）
//
// mock 边界在 ipc 层（window.api 替换），store 逻辑全真（momo-test-rules）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useGroupStore } from './group.store';
import type { GroupRow } from '../ipc/types';

const mockApi = {
  taskGroup: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    reorder: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn(),
    unarchive: vi.fn(),
    delete: vi.fn(),
  },
};

/** 构造完整 GroupRow fixture（断言生产消费的字段，不用占位符） */
function mkGroup(partial: Partial<GroupRow> & Pick<GroupRow, 'id' | 'name'>): GroupRow {
  return {
    workspaceId: 'ws1',
    color: null,
    position: 1024,
    archivedAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...partial,
  };
}

describe('group.store（Task 10 任务组状态）', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useGroupStore.setState({
      groups: [],
      loading: false,
      error: null,
      currentWorkspaceId: null,
      selectedGroupId: null,
      selectedArchivedGroupId: null,
    });
    mockApi.taskGroup.list.mockClear().mockResolvedValue([]);
    // 动作类 mock 每例自行配置返回值（mockReset 撤掉默认实现，忘配则响亮失败）
    mockApi.taskGroup.create.mockReset();
    mockApi.taskGroup.update.mockReset();
    mockApi.taskGroup.archive.mockReset();
    mockApi.taskGroup.unarchive.mockReset();
    mockApi.taskGroup.delete.mockReset();
  });

  it('load 拉取组列表写入 store 且 loading 复位', async () => {
    const rows = [
      mkGroup({ id: 'G-001', name: '组一', position: 1024 }),
      mkGroup({ id: 'G-002', name: '组二', position: 2048 }),
    ];
    mockApi.taskGroup.list.mockResolvedValue(rows);

    await useGroupStore.getState().load('ws1');

    expect(mockApi.taskGroup.list).toHaveBeenCalledWith('ws1');
    expect(useGroupStore.getState().groups).toEqual(rows);
    expect(useGroupStore.getState().loading).toBe(false);
    expect(useGroupStore.getState().error).toBeNull();
  });

  it('load 失败 → error 记录且 groups 不动（错误路径）', async () => {
    mockApi.taskGroup.list.mockRejectedValue(new Error('IPC 异常'));

    await useGroupStore.getState().load('ws1');

    expect(useGroupStore.getState().error).toBe('IPC 异常');
    expect(useGroupStore.getState().groups).toEqual([]);
    expect(useGroupStore.getState().loading).toBe(false);
  });

  it('create 成功后返回行按 position 追加到本地', async () => {
    useGroupStore.setState({
      groups: [mkGroup({ id: 'G-001', name: '组一', position: 1024 })],
    });
    const created = mkGroup({ id: 'G-002', name: '新组', position: 2048, createdAt: 2000 });
    mockApi.taskGroup.create.mockResolvedValue(created);

    await useGroupStore.getState().create({ workspaceId: 'ws1', name: '新组' });

    expect(mockApi.taskGroup.create).toHaveBeenCalledWith({ workspaceId: 'ws1', name: '新组' });
    expect(useGroupStore.getState().groups.map((g) => g.id)).toEqual(['G-001', 'G-002']);
  });

  it('rename 成功后用返回行替换本地行', async () => {
    const g1 = mkGroup({ id: 'G-001', name: '旧名', position: 1024 });
    useGroupStore.setState({ groups: [g1] });
    mockApi.taskGroup.update.mockResolvedValue({ ...g1, name: '新名', updatedAt: 2000 });

    await useGroupStore.getState().rename('G-001', '新名');

    expect(mockApi.taskGroup.update).toHaveBeenCalledWith('G-001', { name: '新名' });
    expect(useGroupStore.getState().groups[0]?.name).toBe('新名');
    expect(useGroupStore.getState().groups[0]?.updatedAt).toBe(2000);
  });

  it('rename 失败 rethrow 且本地不动（错误路径）', async () => {
    useGroupStore.setState({ groups: [mkGroup({ id: 'G-001', name: '旧名' })] });
    mockApi.taskGroup.update.mockRejectedValue(new Error('组不存在'));

    await expect(useGroupStore.getState().rename('G-001', '新名')).rejects.toThrow('组不存在');
    expect(useGroupStore.getState().groups[0]?.name).toBe('旧名');
  });

  it('setColor 成功后用返回行替换本地行', async () => {
    const g1 = mkGroup({ id: 'G-001', name: '组一', color: null, position: 1024 });
    useGroupStore.setState({ groups: [g1] });
    mockApi.taskGroup.update.mockResolvedValue({ ...g1, color: 'violet', updatedAt: 2000 });

    await useGroupStore.getState().setColor('G-001', 'violet');

    expect(mockApi.taskGroup.update).toHaveBeenCalledWith('G-001', { color: 'violet' });
    expect(useGroupStore.getState().groups[0]?.color).toBe('violet');
  });

  it('reorder 成功后本地镜像 repo 排序语义（(i+1)*1024 重写 + 未列入组 position 不动）', async () => {
    const g1 = mkGroup({ id: 'G-001', name: '一', position: 1024, createdAt: 1000 });
    const g2 = mkGroup({ id: 'G-002', name: '二', position: 2048, createdAt: 2000 });
    const g3 = mkGroup({ id: 'G-003', name: '三', position: 3072, createdAt: 3000 });
    useGroupStore.setState({ groups: [g1, g2, g3] });

    await useGroupStore.getState().reorder(['G-002', 'G-001']);

    expect(mockApi.taskGroup.reorder).toHaveBeenCalledWith(['G-002', 'G-001']);
    // 镜像 repo：G-002→1024、G-001→2048、G-003 保持 3072
    expect(useGroupStore.getState().groups.map((g) => g.id)).toEqual(['G-002', 'G-001', 'G-003']);
    // 本地 position 值同步重写（后续排序动作依赖它，不能只排数组不改值）
    expect(useGroupStore.getState().groups.map((g) => g.position)).toEqual([1024, 2048, 3072]);
  });

  it('archive 成功后本地剔除该组', async () => {
    useGroupStore.setState({
      groups: [
        mkGroup({ id: 'G-001', name: '一', position: 1024 }),
        mkGroup({ id: 'G-002', name: '二', position: 2048 }),
      ],
    });
    mockApi.taskGroup.archive.mockResolvedValue({ cancelledIds: ['T-1'], archivedCount: 3 });

    await useGroupStore.getState().archive('G-001');

    expect(mockApi.taskGroup.archive).toHaveBeenCalledWith('G-001');
    expect(useGroupStore.getState().groups.map((g) => g.id)).toEqual(['G-002']);
  });

  it('archive 失败 rethrow 且组保留（错误路径）', async () => {
    useGroupStore.setState({ groups: [mkGroup({ id: 'G-001', name: '一' })] });
    mockApi.taskGroup.archive.mockRejectedValue(new Error('组不存在'));

    await expect(useGroupStore.getState().archive('G-001')).rejects.toThrow('组不存在');
    expect(useGroupStore.getState().groups.map((g) => g.id)).toEqual(['G-001']);
  });

  it('unarchive 成功后返回行按 position 塞回排序', async () => {
    useGroupStore.setState({
      groups: [
        mkGroup({ id: 'G-001', name: '一', position: 1024 }),
        mkGroup({ id: 'G-003', name: '三', position: 3072 }),
      ],
    });
    const restored = mkGroup({ id: 'G-002', name: '二', position: 2048 });
    mockApi.taskGroup.unarchive.mockResolvedValue(restored);

    await useGroupStore.getState().unarchive('G-002');

    expect(mockApi.taskGroup.unarchive).toHaveBeenCalledWith('G-002');
    expect(useGroupStore.getState().groups.map((g) => g.id)).toEqual(['G-001', 'G-002', 'G-003']);
    expect(useGroupStore.getState().groups[1]?.archivedAt).toBeNull(); // 解档后的返回行
  });

  it('delete 成功后本地剔除该组并重拉组列表（契约锁 (id, moveToGroupId) 入参）', async () => {
    useGroupStore.setState({
      currentWorkspaceId: 'ws1',
      groups: [
        mkGroup({ id: 'G-001', name: '一', position: 1024 }),
        mkGroup({ id: 'G-002', name: '二', position: 2048 }),
      ],
    });
    mockApi.taskGroup.delete.mockResolvedValue({ movedCount: 3 });
    // 重拉返回权威值：只剩 G-002
    mockApi.taskGroup.list.mockResolvedValue([mkGroup({ id: 'G-002', name: '二', position: 2048 })]);

    await useGroupStore.getState().delete('G-001', null);

    expect(mockApi.taskGroup.delete).toHaveBeenCalledWith('G-001', null);
    expect(mockApi.taskGroup.list).toHaveBeenCalledWith('ws1');
    expect(useGroupStore.getState().groups.map((g) => g.id)).toEqual(['G-002']);
  });

  it('delete 被删组正被选中过滤 → selectedGroupId 置 null（回「全部」）', async () => {
    useGroupStore.setState({
      currentWorkspaceId: 'ws1',
      groups: [mkGroup({ id: 'G-001', name: '一' }), mkGroup({ id: 'G-002', name: '二' })],
      selectedGroupId: 'G-001',
    });
    mockApi.taskGroup.delete.mockResolvedValue({ movedCount: 0 });
    mockApi.taskGroup.list.mockResolvedValue([mkGroup({ id: 'G-002', name: '二' })]);

    await useGroupStore.getState().delete('G-001', 'G-002');

    expect(useGroupStore.getState().selectedGroupId).toBeNull();
    expect(useGroupStore.getState().groups.map((g) => g.id)).toEqual(['G-002']);
  });

  it('delete 失败 rethrow 且本地不动（错误路径）', async () => {
    useGroupStore.setState({
      currentWorkspaceId: 'ws1',
      groups: [mkGroup({ id: 'G-001', name: '一' })],
      selectedGroupId: 'G-001',
    });
    mockApi.taskGroup.delete.mockRejectedValue(new Error('转移目标组已归档，不能作为转移目标'));

    await expect(useGroupStore.getState().delete('G-001', 'G-009')).rejects.toThrow('已归档');
    expect(useGroupStore.getState().groups.map((g) => g.id)).toEqual(['G-001']);
    expect(useGroupStore.getState().selectedGroupId).toBe('G-001');
    expect(mockApi.taskGroup.list).not.toHaveBeenCalled(); // 失败不重拉
  });

  it('reset 清空组列表与错误态', async () => {
    mockApi.taskGroup.list.mockResolvedValue([mkGroup({ id: 'G-001', name: '一' })]);
    await useGroupStore.getState().load('ws1');

    useGroupStore.getState().reset();

    expect(useGroupStore.getState().groups).toEqual([]);
    expect(useGroupStore.getState().currentWorkspaceId).toBeNull();
  });

  // —— 归档组过滤（selectedArchivedGroupId）：互斥与清除单点在 store 动作内强制 ——

  it('setSelectedGroupId 置位时清除 selectedArchivedGroupId（选中互斥单点强制）', () => {
    useGroupStore.setState({ selectedGroupId: null, selectedArchivedGroupId: 'G-Z1' });

    useGroupStore.getState().setSelectedGroupId('G-001');

    expect(useGroupStore.getState().selectedGroupId).toBe('G-001');
    expect(useGroupStore.getState().selectedArchivedGroupId).toBeNull();
  });

  it('setSelectedArchivedGroupId 置位时清除 selectedGroupId（反向互斥）', () => {
    useGroupStore.setState({ selectedGroupId: 'G-001', selectedArchivedGroupId: null });

    useGroupStore.getState().setSelectedArchivedGroupId('G-Z1');

    expect(useGroupStore.getState().selectedArchivedGroupId).toBe('G-Z1');
    expect(useGroupStore.getState().selectedGroupId).toBeNull();
  });

  it('unarchive 命中正查看的归档组 → selectedArchivedGroupId 清空', async () => {
    useGroupStore.setState({ selectedArchivedGroupId: 'G-Z1' });
    mockApi.taskGroup.unarchive.mockResolvedValue(mkGroup({ id: 'G-Z1', name: '归档组' }));

    await useGroupStore.getState().unarchive('G-Z1');

    expect(useGroupStore.getState().selectedArchivedGroupId).toBeNull();
  });

  it('unarchive 不命中当前查看的归档组 → selectedArchivedGroupId 不动', async () => {
    useGroupStore.setState({ selectedArchivedGroupId: 'G-Z2' });
    mockApi.taskGroup.unarchive.mockResolvedValue(mkGroup({ id: 'G-Z1', name: '归档组一' }));

    await useGroupStore.getState().unarchive('G-Z1');

    expect(useGroupStore.getState().selectedArchivedGroupId).toBe('G-Z2');
  });

  it('load 切 workspace 时连带清空 selectedArchivedGroupId（旧 ws 的选中无意义）', async () => {
    useGroupStore.setState({ currentWorkspaceId: 'ws1', selectedArchivedGroupId: 'G-Z1' });
    mockApi.taskGroup.list.mockResolvedValue([]);

    await useGroupStore.getState().load('ws2');

    expect(useGroupStore.getState().currentWorkspaceId).toBe('ws2');
    expect(useGroupStore.getState().selectedArchivedGroupId).toBeNull();
  });

  it('reset 清空 selectedArchivedGroupId', () => {
    useGroupStore.setState({ selectedArchivedGroupId: 'G-Z1' });

    useGroupStore.getState().reset();

    expect(useGroupStore.getState().selectedArchivedGroupId).toBeNull();
  });
});
