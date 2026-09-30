// renderer/src/stores/task.store.test.ts
//
// task.store 用例：
//   - selectedTaskId（P2 Task 3）：选中态从 TaskBoardView 本地 state
//     提升到 store——侧边栏（TaskSidebarPanel）写、主区（TaskBoardView）读
//   - load（v2.3 P0 修复）：全生命周期拉取——不按状态过滤 + orderBy created_at
//     + limit 500 截断终态历史（「启动即消失」bug 家族的数据层根因：
//     旧 load 只拉 draft/pending/assigned，in_progress/paused 任务进不了看板）
//   - move/archive/unarchive（看板重构 Task 10）：乐观更新 + 行级回滚 +
//     pendingMoveCount/dragging 轮询守卫（Review Focus ④）
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTaskStore } from './task.store';
import type { TaskRow } from '../ipc/types';

const mockApi = {
  task: {
    list: vi.fn().mockResolvedValue([]),
    move: vi.fn(),
    setPinned: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
  },
};

/** 构造完整 TaskRow fixture（momo-test-rules：断言生产消费的字段，不用占位符） */
function mkTask(partial: Partial<TaskRow> & Pick<TaskRow, 'id' | 'title' | 'status'>): TaskRow {
  return {
    workspaceId: 'ws1',
    description: '',
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'user-1',
    executionSessionId: null,
    assigneeAgentId: null,
    targetTeamId: null,
    targetSessionId: null,
    recurrenceParentId: null,
    priority: 0,
    scheduledAt: null,
    recurrenceRule: null,
    deadlineAt: null,
    queuePosition: null,
    runtimeInstanceId: null,
    estimatedTokens: null,
    actualTokens: null,
    toolCallsUsed: 0,
    errorMessage: null,
    sourceNodeId: null,
    createdAt: 1000,
    updatedAt: 1000,
    startedAt: null,
    completedAt: null,
    groupId: null,
    pinnedAt: null,
    archivedAt: null,
    ...partial,
  };
}

describe('task.store selectedTaskId（P2 Task 3）', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      loading: false,
      error: null,
      currentWorkspaceId: null,
    });
    mockApi.task.list.mockClear().mockResolvedValue([]);
  });

  it('setSelectedTaskId 设置选中任务', () => {
    useTaskStore.getState().setSelectedTaskId('t-1');
    expect(useTaskStore.getState().selectedTaskId).toBe('t-1');
  });

  it('setSelectedTaskId(null) 清除选中', () => {
    useTaskStore.getState().setSelectedTaskId('t-1');
    useTaskStore.getState().setSelectedTaskId(null);
    expect(useTaskStore.getState().selectedTaskId).toBeNull();
  });

  it('reset 清空任务列表同时清除选中态', () => {
    useTaskStore.getState().setSelectedTaskId('t-1');
    useTaskStore.getState().reset();
    expect(useTaskStore.getState().selectedTaskId).toBeNull();
    expect(useTaskStore.getState().tasks).toEqual([]);
  });
});

describe('task.store load（v2.3 全生命周期拉取）', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      loading: false,
      error: null,
      currentWorkspaceId: null,
    });
    mockApi.task.list.mockClear().mockResolvedValue([]);
  });

  it('load 拉全生命周期任务（不按状态过滤，created_at_desc + limit 500 保留最新 500 条）', async () => {
    await useTaskStore.getState().load('ws1');
    expect(mockApi.task.list).toHaveBeenCalledWith({ workspaceId: 'ws1', orderBy: 'created_at_desc', limit: 500 });
  });

  it('load 成功后任务写入 store 且 loading 复位（含 in_progress/paused/终态）', async () => {
    const rows = [
      mkTask({ id: 'T-1', title: '执行中', status: 'in_progress' }),
      mkTask({ id: 'T-2', title: '已暂停', status: 'paused' }),
      mkTask({ id: 'T-3', title: '已完成', status: 'completed' }),
    ];
    mockApi.task.list.mockResolvedValue(rows);
    await useTaskStore.getState().load('ws1');
    expect(useTaskStore.getState().tasks).toEqual(rows);
    expect(useTaskStore.getState().loading).toBe(false);
    expect(useTaskStore.getState().error).toBeNull();
  });

  it('load 失败 → error 记录且 loading 复位（错误路径专项）', async () => {
    mockApi.task.list.mockRejectedValue(new Error('IPC 异常'));
    await useTaskStore.getState().load('ws1');
    expect(useTaskStore.getState().error).toBe('IPC 异常');
    expect(useTaskStore.getState().loading).toBe(false);
    expect(useTaskStore.getState().tasks).toEqual([]);
  });
});

// 看板 workspace 隔离回归锁（重启激活分歧缺陷4实例）：TaskBoardView 的 effect
// 已按 workspaceId prop 重 load（列表响应式 ✓），但 selectedTaskId 残留旧 ws——
// TaskDetailPanel 按 taskId 直查 ipc.task.get，旧 ws 任务详情会顶进新 ws 看板。
// store 侧按 currentWorkspaceId 判变重置（对齐 session.store 先例），
// 覆盖「切 ws 时看板未挂载 → 之后挂载 load(newWs)」的时序洞。
describe('task.store — workspace 切换重置（看板隔离回归锁）', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      loading: false,
      error: null,
      currentWorkspaceId: null,
    });
    mockApi.task.list.mockClear().mockResolvedValue([]);
  });

  it('load 不同 workspace 时清空旧任务并重置 selectedTaskId', async () => {
    const ws1Rows = [mkTask({ id: 'T-1', title: 'ws1 任务', status: 'in_progress' })];
    mockApi.task.list.mockResolvedValue(ws1Rows);
    await useTaskStore.getState().load('ws1');
    useTaskStore.getState().setSelectedTaskId('T-1');

    const ws2Rows = [mkTask({ id: 'T-9', title: 'ws2 任务', status: 'pending', workspaceId: 'ws2' })];
    mockApi.task.list.mockResolvedValue(ws2Rows);
    await useTaskStore.getState().load('ws2');

    expect(useTaskStore.getState().selectedTaskId).toBeNull();
    expect(useTaskStore.getState().tasks).toEqual(ws2Rows);
  });

  it('load 同一 workspace 重复调用保留 selectedTaskId（刷新不清选中）', async () => {
    mockApi.task.list.mockResolvedValue([mkTask({ id: 'T-1', title: '任务', status: 'draft' })]);
    await useTaskStore.getState().load('ws1');
    useTaskStore.getState().setSelectedTaskId('T-1');

    await useTaskStore.getState().load('ws1');

    expect(useTaskStore.getState().selectedTaskId).toBe('T-1');
  });
});

// ── 看板重构 Task 10：乐观 move / 回滚 / 轮询守卫（Review Focus ④）─────────────
//
// 核心语义四条：
//   1. move 乐观更新：本地先变（列代表状态 + groupId 同步），IPC 成功用返回行覆盖
//   2. move 失败：回滚目标行 + rethrow（上层 toast）；不踩踏并发在途的成功行
//   3. pendingMoveCount 守卫：move 在途时 load 直接返回（防 5s 轮询覆盖在途乐观态）
//   4. dragging 守卫：拖拽手持中 load 跳过（松手后恢复轮询生效）
// 另覆盖 archive 本地剔除 / unarchive 塞回（Task 10 增量动作）及各自错误路径。
describe('task.store pin（顶置乐观更新 + 回滚，迁移 050）', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      loading: false,
      error: null,
      currentWorkspaceId: null,
      pendingMoveCount: 0,
      dragging: false,
    });
    mockApi.task.setPinned.mockReset();
  });

  it('pin 乐观更新：本地 pinnedAt 先置，IPC 成功后用权威行覆盖', async () => {
    const t = mkTask({ id: 'T-001', title: '任务', status: 'draft', pinnedAt: null });
    let resolvePin!: (v: TaskRow) => void;
    mockApi.task.setPinned.mockReturnValue(
      new Promise<TaskRow>((r) => {
        resolvePin = r;
      }),
    );
    useTaskStore.setState({ tasks: [t] });

    const p = useTaskStore.getState().pin('T-001', true);
    // 乐观阶段：pinnedAt 已非空（排序即时生效），未等 IPC
    expect(useTaskStore.getState().tasks[0]!.pinnedAt).not.toBeNull();
    resolvePin({ ...t, pinnedAt: 424242 });
    await p;
    expect(useTaskStore.getState().tasks[0]!.pinnedAt).toBe(424242);
    expect(mockApi.task.setPinned).toHaveBeenCalledWith('T-001', true);
  });

  it('unpin → pinnedAt 置空透传 false', async () => {
    const t = mkTask({ id: 'T-001', title: '任务', status: 'draft', pinnedAt: 999 });
    mockApi.task.setPinned.mockResolvedValue({ ...t, pinnedAt: null });
    useTaskStore.setState({ tasks: [t] });
    await useTaskStore.getState().pin('T-001', false);
    expect(useTaskStore.getState().tasks[0]!.pinnedAt).toBeNull();
  });

  it('pin 失败：回滚目标行 + rethrow（错误路径）', async () => {
    const t = mkTask({ id: 'T-001', title: '任务', status: 'draft', pinnedAt: null });
    const other = mkTask({ id: 'T-002', title: '任务二', status: 'draft', pinnedAt: 1 });
    mockApi.task.setPinned.mockRejectedValue(new Error('任务不存在'));
    useTaskStore.setState({ tasks: [t, other] });
    await expect(useTaskStore.getState().pin('T-001', true)).rejects.toThrow('任务不存在');
    // 行级回滚：T-001 恢复 null，T-002 不受影响
    expect(useTaskStore.getState().tasks[0]!.pinnedAt).toBeNull();
    expect(useTaskStore.getState().tasks[1]!.pinnedAt).toBe(1);
  });
});

describe('task.store move（乐观更新 + 回滚 + 轮询守卫，Task 10）', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      loading: false,
      error: null,
      currentWorkspaceId: null,
      pendingMoveCount: 0,
      dragging: false,
    });
    mockApi.task.list.mockClear().mockResolvedValue([]);
    // move/archive/unarchive 每例自行配置返回值（mockReset 撤掉默认实现，
    // 忘配则测试响亮失败而非静默通过）
    mockApi.task.move.mockReset();
    mockApi.task.setPinned.mockReset();
    mockApi.task.archive.mockReset();
    mockApi.task.unarchive.mockReset();
  });

  it('move 乐观更新：本地先变（列代表状态 + groupId），IPC 成功后用返回行覆盖', async () => {
    const t = mkTask({ id: 'T-001', title: '任务', status: 'draft', groupId: null });
    let resolveMove!: (v: TaskRow) => void;
    mockApi.task.move.mockReturnValue(
      new Promise<TaskRow>((r) => {
        resolveMove = r;
      }),
    );
    useTaskStore.setState({ tasks: [t] });

    const p = useTaskStore.getState().move('T-001', { column: 'assigned', groupId: 'G-001' });

    // 乐观阶段：IPC 未返回，本地已是目标列代表状态 + 目标组
    expect(useTaskStore.getState().tasks[0]?.status).toBe('assigned');
    expect(useTaskStore.getState().tasks[0]?.groupId).toBe('G-001');
    expect(useTaskStore.getState().pendingMoveCount).toBe(1);
    expect(mockApi.task.move).toHaveBeenCalledWith('T-001', { column: 'assigned', groupId: 'G-001' });

    resolveMove({ ...t, status: 'assigned', groupId: 'G-001', updatedAt: 2000 });
    await p;

    // 权威行覆盖：服务端字段（updatedAt 等）生效，计数复位
    expect(useTaskStore.getState().tasks[0]?.updatedAt).toBe(2000);
    expect(useTaskStore.getState().pendingMoveCount).toBe(0);
  });

  it('move 到 backlog 列：乐观阶段保持原状态（仅换组/排序，无状态映射）', async () => {
    const t = mkTask({ id: 'T-002', title: '任务', status: 'draft', groupId: 'G-001' });
    let resolveMove!: (v: TaskRow) => void;
    mockApi.task.move.mockReturnValue(
      new Promise<TaskRow>((r) => {
        resolveMove = r;
      }),
    );
    useTaskStore.setState({ tasks: [t] });

    const p = useTaskStore.getState().move('T-002', { column: 'backlog', groupId: null });

    // backlog 不在乐观状态映射表内：状态不变，仅 groupId 乐观切换
    expect(useTaskStore.getState().tasks[0]?.status).toBe('draft');
    expect(useTaskStore.getState().tasks[0]?.groupId).toBeNull();

    resolveMove({ ...t, groupId: null, updatedAt: 2000 });
    await p;
    expect(useTaskStore.getState().tasks[0]?.status).toBe('draft');
  });

  it('move 失败：回滚目标行 + rethrow（Review Focus ④）', async () => {
    const t = mkTask({ id: 'T-003', title: '任务', status: 'draft', groupId: null });
    mockApi.task.move.mockRejectedValue(new Error('状态机不允许'));
    useTaskStore.setState({ tasks: [t] });

    await expect(
      useTaskStore.getState().move('T-003', { column: 'done', groupId: null }),
    ).rejects.toThrow('状态机不允许');

    // 乐观行回滚到快照（状态 + groupId），计数在 finally 复位
    expect(useTaskStore.getState().tasks[0]?.status).toBe('draft');
    expect(useTaskStore.getState().tasks[0]?.groupId).toBeNull();
    expect(useTaskStore.getState().pendingMoveCount).toBe(0);
  });

  it('move 失败回滚不踩踏并发在途的成功行（行级回滚，非整表快照）', async () => {
    const a = mkTask({ id: 'T-A', title: 'A', status: 'draft' });
    const b = mkTask({ id: 'T-B', title: 'B', status: 'draft' });
    useTaskStore.setState({ tasks: [a, b] });
    let resolveB!: (v: TaskRow) => void;
    let rejectA!: (e: Error) => void;
    mockApi.task.move.mockImplementation((id: string) =>
      id === 'T-A'
        ? new Promise<TaskRow>((_res, rej) => {
            rejectA = rej;
          })
        : new Promise<TaskRow>((res) => {
            resolveB = res;
          }),
    );

    const pa = useTaskStore.getState().move('T-A', { column: 'assigned', groupId: null });
    const pb = useTaskStore.getState().move('T-B', { column: 'active', groupId: null });
    // B 先成功落定，A 之后失败——A 的回滚不得把 B 拖回快照
    resolveB({ ...b, status: 'in_progress' });
    await pb;
    rejectA(new Error('A 不允许'));
    await expect(pa).rejects.toThrow('A 不允许');

    const rows = useTaskStore.getState().tasks;
    expect(rows.find((row) => row.id === 'T-A')?.status).toBe('draft');
    expect(rows.find((row) => row.id === 'T-B')?.status).toBe('in_progress');
    expect(useTaskStore.getState().pendingMoveCount).toBe(0);
  });

  it('move 在途时 load 不覆盖乐观态（pendingMoveCount 守卫）', async () => {
    const t = mkTask({ id: 'T-004', title: '任务', status: 'draft' });
    let resolveMove!: (v: TaskRow) => void;
    mockApi.task.move.mockReturnValue(
      new Promise<TaskRow>((r) => {
        resolveMove = r;
      }),
    );
    useTaskStore.setState({ tasks: [t], currentWorkspaceId: 'ws1' });

    const p = useTaskStore.getState().move('T-004', { column: 'assigned', groupId: null });
    mockApi.task.list.mockResolvedValue([]); // 轮询返回空列表（模拟服务端旧快照）

    await useTaskStore.getState().load('ws1');

    // 未被空列表覆盖，乐观态保持
    expect(useTaskStore.getState().tasks).toHaveLength(1);
    expect(useTaskStore.getState().tasks[0]?.status).toBe('assigned');

    resolveMove({ ...t, status: 'assigned' });
    await p;
    expect(useTaskStore.getState().pendingMoveCount).toBe(0);
  });

  it('dragging 时 load 跳过，松手后恢复（dragging 守卫）', async () => {
    const t = mkTask({ id: 'T-005', title: '任务', status: 'draft' });
    useTaskStore.setState({ tasks: [t], currentWorkspaceId: 'ws1' });

    useTaskStore.getState().setDragging(true);
    mockApi.task.list.mockResolvedValue([]);
    await useTaskStore.getState().load('ws1');
    expect(useTaskStore.getState().tasks).toHaveLength(1);

    useTaskStore.getState().setDragging(false);
    await useTaskStore.getState().load('ws1');
    expect(useTaskStore.getState().tasks).toHaveLength(0); // 松手后轮询恢复生效
  });

  it('archive 成功后本地 tasks 剔除该行', async () => {
    const a = mkTask({ id: 'T-A', title: 'A', status: 'completed' });
    const b = mkTask({ id: 'T-B', title: 'B', status: 'draft' });
    mockApi.task.archive.mockResolvedValue({ ...a, archivedAt: 9000 });
    useTaskStore.setState({ tasks: [a, b] });

    await useTaskStore.getState().archive('T-A');

    expect(mockApi.task.archive).toHaveBeenCalledWith('T-A');
    expect(useTaskStore.getState().tasks.map((row) => row.id)).toEqual(['T-B']);
  });

  it('archive 失败 rethrow 且本地不动（错误路径：非终态不可归档）', async () => {
    const a = mkTask({ id: 'T-A', title: 'A', status: 'in_progress' });
    useTaskStore.setState({ tasks: [a] });
    mockApi.task.archive.mockRejectedValue(new Error('非终态任务不可归档'));

    await expect(useTaskStore.getState().archive('T-A')).rejects.toThrow('非终态任务不可归档');
    expect(useTaskStore.getState().tasks.map((row) => row.id)).toEqual(['T-A']);
  });

  it('unarchive 成功后把返回行塞回 tasks', async () => {
    const restored = mkTask({ id: 'T-U', title: '复活', status: 'completed' });
    mockApi.task.unarchive.mockResolvedValue({ ...restored, archivedAt: null });
    useTaskStore.setState({ tasks: [] });

    await useTaskStore.getState().unarchive('T-U');

    expect(mockApi.task.unarchive).toHaveBeenCalledWith('T-U');
    expect(useTaskStore.getState().tasks).toHaveLength(1);
    expect(useTaskStore.getState().tasks[0]?.id).toBe('T-U');
    expect(useTaskStore.getState().tasks[0]?.archivedAt).toBeNull(); // 塞回的是解档后的返回行
  });

  it('unarchive 失败 rethrow 且本地不动（错误路径）', async () => {
    mockApi.task.unarchive.mockRejectedValue(new Error('任务不存在'));
    useTaskStore.setState({ tasks: [] });

    await expect(useTaskStore.getState().unarchive('T-X')).rejects.toThrow('任务不存在');
    expect(useTaskStore.getState().tasks).toHaveLength(0);
  });
});
