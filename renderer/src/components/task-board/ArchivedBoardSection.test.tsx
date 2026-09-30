// renderer/src/components/task-board/ArchivedBoardSection.test.tsx
//
// 归档看板只读泳道测试（归档组点击 → 主区只读看板改造）：
//   - 泳道头：组色点 + 组名 + 计数 + 「已归档 · 只读」标识；无 GroupMenu
//   - 列体：任务按 column.statuses 分桶进 BOARD_COLUMNS 对列
//   - 只读结构性断言：无 sortable 痕迹（无 role="button"+aria-roledescription=
//     "sortable" 组合、无 draggable）、卡片点击只走 onSelect 回调（开只读详情
//     接线，组件自身零 store 副作用）、selectedId 选中高亮、右键不弹任务菜单
//   - 空任务组：五列空态（「暂无」）
//
// mock 边界：仅 mock window.api（BoardCard→useTaskEntityNames 兜底拉取 reject 走
// 名称回退）；group.store / task.store 真实实现。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ArchivedBoardSection } from './ArchivedBoardSection';
import { useTaskStore } from '../../stores/task.store';
import type { GroupRow, TaskRow } from '../../ipc/types';

function mkGroup(partial: Partial<GroupRow> & Pick<GroupRow, 'id' | 'name'>): GroupRow {
  return {
    workspaceId: 'ws-1',
    color: null,
    position: 1024,
    archivedAt: 111,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function mkTask(partial: Partial<TaskRow> & Pick<TaskRow, 'id' | 'status'>): TaskRow {
  return {
    workspaceId: 'ws-1',
    title: `任务-${partial.id}`,
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
    createdAt: 1000,
    updatedAt: 1000,
    startedAt: null,
    completedAt: null,
    groupId: 'g-z1',
    pinnedAt: null,
    archivedAt: 999,
    ...partial,
  };
}

const G_Z = mkGroup({ id: 'g-z1', name: '归档组一', color: 'violet' });

const mockApi = {
  task: { list: vi.fn().mockResolvedValue([]) },
  taskGroup: { list: vi.fn().mockResolvedValue([]) },
  agent: { listMembers: vi.fn().mockRejectedValue(new Error('no ipc')) },
  team: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
  session: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
};

describe('ArchivedBoardSection（只读归档泳道）', () => {
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
    mockApi.agent.listMembers.mockClear().mockRejectedValue(new Error('no ipc'));
    mockApi.team.list.mockClear().mockRejectedValue(new Error('no ipc'));
    mockApi.session.list.mockClear().mockRejectedValue(new Error('no ipc'));
  });

  it('泳道头：组名 + 计数 + 「已归档 · 只读」标识；无 GroupMenu', () => {
    const tasks = [mkTask({ id: 't1', title: '归档任务甲', status: 'completed' })];
    render(<ArchivedBoardSection group={G_Z} tasks={tasks} selectedId={null} onSelect={vi.fn()} />);

    const header = screen.getByRole('heading', { name: /归档组一/ });
    expect(header).toBeInTheDocument();
    expect(within(header).getByText('1')).toBeInTheDocument();
    expect(screen.getByText('已归档 · 只读')).toBeInTheDocument();
    // 无 GroupMenu（归档组无重命名/换色/归档操作）
    expect(screen.queryByLabelText('泳道菜单 归档组一')).not.toBeInTheDocument();
  });

  it('任务按状态进对列（BOARD_COLUMNS 分桶：pending→待办 / in_progress→进行中 / failed→已关闭）', () => {
    const tasks = [
      mkTask({ id: 't1', title: '待办任务', status: 'pending' }),
      mkTask({ id: 't2', title: '进行中任务', status: 'in_progress' }),
      mkTask({ id: 't3', title: '失败任务', status: 'failed' }),
    ];
    render(<ArchivedBoardSection group={G_Z} tasks={tasks} selectedId={null} onSelect={vi.fn()} />);

    const backlog = screen.getByLabelText('待办');
    expect(within(backlog).getByText(/待办任务/)).toBeInTheDocument();
    const active = screen.getByLabelText('进行中');
    expect(within(active).getByText(/进行中任务/)).toBeInTheDocument();
    const closed = screen.getByLabelText('已关闭');
    expect(within(closed).getByText(/失败任务/)).toBeInTheDocument();
    // 其余列不受影响（已完成列无这三张卡）
    const done = screen.getByLabelText('已完成');
    expect(within(done).queryByText(/待办任务|进行中任务|失败任务/)).not.toBeInTheDocument();
  });

  it('只读结构性断言：无 sortable 痕迹、无 draggable；点击卡片只走 onSelect 接线', () => {
    const tasks = [mkTask({ id: 't1', title: '归档任务甲', status: 'pending' })];
    const onSelect = vi.fn();
    render(<ArchivedBoardSection group={G_Z} tasks={tasks} selectedId={null} onSelect={onSelect} />);

    // useSortable 会挂 role="button" + aria-roledescription="sortable" 组合——全容器无此痕迹
    const section = screen.getByLabelText('归档看板 归档组一');
    expect(section.querySelectorAll('[aria-roledescription="sortable"]')).toHaveLength(0);
    expect(section.querySelectorAll('[draggable="true"]')).toHaveLength(0);

    // 卡片可点击：只调 onSelect 回调（TaskBoardView 接 setSelectedTaskId 开只读
    // 详情抽屉）；组件自身零 store 写入
    fireEvent.click(screen.getByRole('button', { name: /归档任务甲/ }));
    expect(onSelect).toHaveBeenCalledWith('t1');
    expect(useTaskStore.getState().selectedTaskId).toBeNull();
  });

  it('selectedId 选中高亮：匹配卡 aria-pressed=true，其余卡不受影响', () => {
    const tasks = [
      mkTask({ id: 't1', title: '归档任务甲', status: 'pending' }),
      mkTask({ id: 't2', title: '归档任务乙', status: 'completed' }),
    ];
    render(<ArchivedBoardSection group={G_Z} tasks={tasks} selectedId="t1" onSelect={vi.fn()} />);

    expect(screen.getByRole('button', { name: /归档任务甲/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /归档任务乙/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('右键卡片不弹任务菜单（只读视图无编辑/归档入口）', () => {
    const tasks = [mkTask({ id: 't1', title: '归档任务甲', status: 'pending' })];
    render(<ArchivedBoardSection group={G_Z} tasks={tasks} selectedId={null} onSelect={vi.fn()} />);

    fireEvent.contextMenu(screen.getByRole('button', { name: /归档任务甲/ }));
    expect(screen.queryByLabelText('任务菜单 归档任务甲')).not.toBeInTheDocument();
  });

  it('空任务组：五列全渲染且均为空态「暂无」', () => {
    render(<ArchivedBoardSection group={G_Z} tasks={[]} selectedId={null} onSelect={vi.fn()} />);

    expect(within(screen.getByLabelText('归档看板 归档组一')).getAllByText('暂无')).toHaveLength(5);
  });
});
