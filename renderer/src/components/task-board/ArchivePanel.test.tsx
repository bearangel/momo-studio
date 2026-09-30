// renderer/src/components/task-board/ArchivePanel.test.tsx
//
// 归档面板测试（看板重构 Task 14）：
//   - 数据契约：open 时 task.list({archived:'only', orderBy, limit}) +
//     taskGroup.list(ws, {archived:'all'}) 并行拉取（组名 map）
//   - 渲染：归档行（#短ID·标题 / 组名 / 状态徽标 / 归档时间）+ 空态
//   - 单条恢复：调 task.store.unarchive（真实 store → ipc.task.unarchive）后行消失
//   - 批量恢复：勾选 n → 按列表序逐条 unarchive
//   - 恢复整组：select 选归档组 → 一次 taskGroup.unarchive（组+任务一体恢复）
//     后重拉面板数据并刷新看板任务；失败 toast 行保留
//   - 过滤：搜索框（标题）+ 组 select + 状态 select
//
// mock 边界（momo-test-rules #5）：仅 mock window.api（IPC 边界），task.store 用
// 真实实现——恢复动作链（unarchive → 本地 tasks 追加）在测试里真实走通。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ArchivePanel } from './ArchivePanel';
import { useTaskStore } from '../../stores/task.store';
import { useGroupStore } from '../../stores/group.store';
import type { GroupRow, TaskRow } from '../../ipc/types';

/** 归档时间基準（固定值保证断言稳定） */
const T0 = 1_760_000_000_000;

function mkTask(partial: Partial<TaskRow> & Pick<TaskRow, 'id' | 'title' | 'status'>): TaskRow {
  return {
    workspaceId: 'ws-1',
    description: '',
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'user-1',
    executionSessionId: null,
    assigneeAgentId: null,
    targetTeamId: null,
    targetSessionId: null,
    recurrenceParentId: null,
    priority: 5,
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
    createdAt: T0,
    updatedAt: T0,
    startedAt: null,
    completedAt: null,
    groupId: null,
    pinnedAt: null,
    archivedAt: T0,
    ...partial,
  };
}

function mkGroup(partial: Partial<GroupRow> & Pick<GroupRow, 'id' | 'name'>): GroupRow {
  return {
    workspaceId: 'ws-1',
    color: null,
    position: 1024,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

// 归档任务 fixture：G1(已归档组) 两条 + 无组一条
const T_IN_G1_A = mkTask({ id: 'T-0001aa', title: '归档任务甲', status: 'completed', groupId: 'g-1' });
const T_IN_G1_B = mkTask({ id: 'T-0002bb', title: '归档任务乙', status: 'cancelled', groupId: 'g-1' });
const T_NO_GROUP = mkTask({ id: 'T-0003cc', title: '归档任务丙', status: 'failed', archivedAt: T0 + 1000 });

const GROUPS_ALL: GroupRow[] = [
  mkGroup({ id: 'g-1', name: '已归档组', position: 2048, archivedAt: T0 }),
  mkGroup({ id: 'g-2', name: '活跃组', position: 1024 }),
];

const mockApi = {
  task: {
    list: vi.fn(),
    unarchive: vi.fn(),
  },
  taskGroup: {
    list: vi.fn(),
    unarchive: vi.fn(),
  },
};

/** 归档行定位：按标题正则找行容器（checkbox 与恢复按钮同行） */
function rowOf(title: string): HTMLElement {
  const el = screen.getByText(new RegExp(title));
  return el.closest('tr, [data-archive-row]') as HTMLElement;
}

describe('ArchivePanel', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    mockApi.task.list.mockReset().mockResolvedValue([T_IN_G1_A, T_IN_G1_B, T_NO_GROUP]);
    mockApi.taskGroup.list.mockReset().mockResolvedValue(GROUPS_ALL);
    mockApi.taskGroup.unarchive
      .mockReset()
      .mockResolvedValue(mkGroup({ ...GROUPS_ALL[0]!, archivedAt: null }));
    mockApi.task.unarchive.mockReset().mockImplementation(async (id: string) =>
      mkTask({ ...T_IN_G1_A, id, archivedAt: null }),
    );
    useTaskStore.setState({ tasks: [], selectedTaskId: null, loading: false, error: null });
    useGroupStore.setState({ groups: [], loading: false, error: null, currentWorkspaceId: null });
  });

  it('open 时按契约拉取归档任务 + 全量组，渲染归档行（短ID·标题/组名/状态徽标/归档时间）', async () => {
    render(<ArchivePanel open onClose={() => undefined} workspaceId="ws-1" />);

    await waitFor(() => {
      expect(mockApi.task.list).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        archived: 'only',
        orderBy: 'created_at_desc',
        limit: 500,
      });
    });
    expect(mockApi.taskGroup.list).toHaveBeenCalledWith('ws-1', { archived: 'all' });

    expect(screen.getByText(/归档任务甲/)).toBeInTheDocument();
    expect(screen.getByText('#T-0001 · 归档任务甲')).toBeInTheDocument();
    // 组名列：g-1 → 已归档组；无组行 → 未分组（过滤下拉 option 与行内单元格同名，按多数断言）
    expect(screen.getAllByText('已归档组').length).toBeGreaterThan(0);
    expect(screen.getAllByText('未分组').length).toBeGreaterThan(0);
    // 状态徽标（task-status.ts 词表；下拉 option 同名，按行 scope 断言）
    expect(within(rowOf('归档任务甲')).getByText('已完成')).toBeInTheDocument();
    expect(within(rowOf('归档任务乙')).getByText('已取消')).toBeInTheDocument();
    expect(within(rowOf('归档任务丙')).getByText('失败')).toBeInTheDocument();
    // 归档时间（与实现同格式断言，锁「有时间列」）
    expect(screen.getAllByText(new Date(T0).toLocaleString()).length).toBeGreaterThan(0);
  });

  it('空数据渲染空态文案', async () => {
    mockApi.task.list.mockResolvedValue([]);
    render(<ArchivePanel open onClose={() => undefined} workspaceId="ws-1" />);
    expect(await screen.findByText('暂无归档任务')).toBeInTheDocument();
  });

  it('单条恢复：调 ipc.task.unarchive → 行消失、其余保留、store.tasks 追加恢复行', async () => {
    render(<ArchivePanel open onClose={() => undefined} workspaceId="ws-1" />);
    await screen.findByText(/归档任务甲/);

    fireEvent.click(within(rowOf('归档任务甲')).getByRole('button', { name: '恢复' }));

    await waitFor(() => {
      expect(mockApi.task.unarchive).toHaveBeenCalledWith('T-0001aa');
    });
    await waitFor(() => {
      expect(screen.queryByText(/归档任务甲/)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/归档任务乙/)).toBeInTheDocument();
    // 真实 store 语义：恢复行回到看板任务列表
    expect(useTaskStore.getState().tasks.some((t) => t.id === 'T-0001aa')).toBe(true);
  });

  it('勾选两条 → 批量恢复按列表序逐条 unarchive，已选计数归零', async () => {
    render(<ArchivePanel open onClose={() => undefined} workspaceId="ws-1" />);
    await screen.findByText(/归档任务甲/);

    fireEvent.click(within(rowOf('归档任务甲')).getByRole('checkbox'));
    fireEvent.click(within(rowOf('归档任务丙')).getByRole('checkbox'));
    expect(screen.getByText(/已选 2/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '批量恢复' }));

    await waitFor(() => {
      expect(mockApi.task.unarchive).toHaveBeenCalledTimes(2);
    });
    // 按列表序（created_at_desc 输入序）：甲 → 丙
    expect(mockApi.task.unarchive.mock.calls.map((c) => c[0])).toEqual(['T-0001aa', 'T-0003cc']);
    await waitFor(() => {
      expect(screen.queryByText(/归档任务甲/)).not.toBeInTheDocument();
      expect(screen.queryByText(/归档任务丙/)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/已选 0/)).toBeInTheDocument();
  });

  it('恢复整组 select：选已归档组 → 一次 taskGroup.unarchive（组+任务一体），面板重拉且看板任务刷新', async () => {
    // task.list 按参数分派：archived:'only' → 面板归档行；无 archived → task.store.load 全量
    let archivedRows: TaskRow[] = [T_IN_G1_A, T_IN_G1_B, T_NO_GROUP];
    let activeRows: TaskRow[] = [];
    mockApi.task.list.mockReset().mockImplementation(
      async (opts?: { archived?: 'exclude' | 'only' | 'all' }) =>
        opts?.archived === 'only' ? archivedRows : activeRows,
    );
    // 服务端语义仿真：unarchive 落库后，两类 list 查询自然返回恢复后的数据
    mockApi.taskGroup.unarchive.mockReset().mockImplementation(async (gid: string) => {
      if (gid !== 'g-1') throw new Error('未知组');
      archivedRows = [T_NO_GROUP];
      activeRows = [{ ...T_IN_G1_A, archivedAt: null }, { ...T_IN_G1_B, archivedAt: null }];
      return mkGroup({ ...GROUPS_ALL[0]!, archivedAt: null });
    });
    render(<ArchivePanel open onClose={() => undefined} workspaceId="ws-1" />);
    await screen.findByText(/归档任务甲/);

    fireEvent.change(screen.getByLabelText('恢复整组'), { target: { value: 'g-1' } });

    await waitFor(() => {
      expect(mockApi.taskGroup.unarchive).toHaveBeenCalledTimes(1);
    });
    expect(mockApi.taskGroup.unarchive).toHaveBeenCalledWith('g-1');
    // 语义修订回归锁：不再逐条 task.unarchive
    expect(mockApi.task.unarchive).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByText(/归档任务甲/)).not.toBeInTheDocument();
      expect(screen.queryByText(/归档任务乙/)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/归档任务丙/)).toBeInTheDocument();
    // 看板任务即时刷新（task.store.load 走无 archived 参数的分派）
    await waitFor(() => {
      expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual(['T-0001aa', 'T-0002bb']);
    });
  });

  it('恢复整组失败：toast 提示且行保留（错误路径）', async () => {
    mockApi.taskGroup.unarchive.mockRejectedValue(new Error('组不存在'));
    render(<ArchivePanel open onClose={() => undefined} workspaceId="ws-1" />);
    await screen.findByText(/归档任务甲/);

    fireEvent.change(screen.getByLabelText('恢复整组'), { target: { value: 'g-1' } });

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
    expect(screen.getByText(/恢复整组失败/)).toBeInTheDocument();
    expect(screen.getByText(/归档任务甲/)).toBeInTheDocument();
    expect(screen.getByText(/归档任务乙/)).toBeInTheDocument();
  });

  it('恢复整组候选只列「还有归档任务的已归档组」', async () => {
    render(<ArchivePanel open onClose={() => undefined} workspaceId="ws-1" />);
    await screen.findByText(/归档任务甲/);

    const select = screen.getByLabelText('恢复整组') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['', 'g-1']); // 占位 + 仅 g-1（活跃组 g-2 不入候选）
  });

  it('过滤：搜索框命中标题、组 select、状态 select 三维 AND 叠加', async () => {
    render(<ArchivePanel open onClose={() => undefined} workspaceId="ws-1" />);
    await screen.findByText(/归档任务甲/);

    // 搜索：只留「乙」
    fireEvent.change(screen.getByLabelText('搜索归档任务'), { target: { value: '乙' } });
    expect(screen.getByText(/归档任务乙/)).toBeInTheDocument();
    expect(screen.queryByText(/归档任务甲/)).not.toBeInTheDocument();
    // 清空搜索 → 组过滤 g-1 只留甲乙
    fireEvent.change(screen.getByLabelText('搜索归档任务'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('按组过滤'), { target: { value: 'g-1' } });
    expect(screen.queryByText(/归档任务丙/)).not.toBeInTheDocument();
    // 叠加状态过滤 failed → 空（g-1 内无 failed）
    fireEvent.change(screen.getByLabelText('按状态过滤'), { target: { value: 'failed' } });
    expect(screen.queryByText(/归档任务甲/)).not.toBeInTheDocument();
    expect(screen.queryByText(/归档任务乙/)).not.toBeInTheDocument();
  });

  it('单条恢复失败：toast 提示且行保留', async () => {
    mockApi.task.unarchive.mockRejectedValue(new Error('任务不存在'));
    render(<ArchivePanel open onClose={() => undefined} workspaceId="ws-1" />);
    await screen.findByText(/归档任务甲/);

    fireEvent.click(within(rowOf('归档任务甲')).getByRole('button', { name: '恢复' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
    expect(screen.getByText(/恢复失败/)).toBeInTheDocument();
    expect(screen.getByText(/归档任务甲/)).toBeInTheDocument();
  });
});
