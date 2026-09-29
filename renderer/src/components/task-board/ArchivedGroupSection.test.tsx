// renderer/src/components/task-board/ArchivedGroupSection.test.tsx
//
// 已归档分组风琴分区测试（归档组点击 → 主区只读看板改造）：
//   - 分区渲染门槛：有归档组才渲染；默认折叠（aria-expanded=false）
//   - 组行 = 选中过滤按钮：点击写 group.store.selectedArchivedGroupId（主区看板
//     切换为该组归档泳道）；aria-pressed 表选中态；再点已选中组行取消（镜像
//     活跃组 toggleSelect 的 `selected ? null : id` 语义）
//   - 选中高亮与活跃组行同款（border-focus bg-surface-active text-primary）
//   - 侧边栏零归档任务拉取：任何交互（展开分区/点选组行）都不发起
//     task.list({archived:'only'})——归档任务展示整体移交主区 ArchivedBoardSection
//   - 「取消归档」按钮结构隔离：不改变选中态；动作走 runUnarchive
//     （unarchive + task.list 级联刷新）
//
// mock 边界：仅 mock window.api；group.store / task.store / workspace.store 真实实现
// （照 GroupManageList.test.tsx 既有模式）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ArchivedGroupSection } from './ArchivedGroupSection';
import { useTaskStore } from '../../stores/task.store';
import { useGroupStore } from '../../stores/group.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { GroupRow, TaskRow, Workspace } from '../../ipc/types';

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

function mkTask(
  partial: Partial<TaskRow> & Pick<TaskRow, 'id' | 'status' | 'groupId'>,
): TaskRow {
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
    boardPosition: null,
    archivedAt: null,
    ...partial,
  };
}

const G_A = mkGroup({ id: 'g-a', name: '组A', position: 1024 });
const G_Z1 = mkGroup({ id: 'g-z1', name: '归档组一', position: 2048, archivedAt: 111 });
const G_Z2 = mkGroup({ id: 'g-z2', name: '归档组二', position: 3072, archivedAt: 222 });

const WS: Workspace = {
  id: 'ws-1',
  name: 'ws',
  description: '',
  directoryPath: '/tmp/ws',
  gitInitialized: false,
  createdAt: '2026-01-01T00:00:00Z',
  ownerId: 'owner',
  iconEmoji: '📁',
  defaultAgentInstanceId: null,
};

const mockApi = {
  taskGroup: {
    list: vi.fn(),
    unarchive: vi.fn(),
  },
  task: {
    list: vi.fn().mockResolvedValue([]),
  },
};

/** 归档任务拉取（archived:'only'）调用次数——与 runUnarchive 级联的看板刷新调用区分 */
function archivedOnlyTaskListCalls(): number {
  return mockApi.task.list.mock.calls.filter(
    ([opts]) => (opts as { archived?: string } | undefined)?.archived === 'only',
  ).length;
}

describe('ArchivedGroupSection', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    // 默认两态：archived:'only' 返回两个归档组；活跃组分支（本组件不消费）兜底
    mockApi.taskGroup.list.mockReset().mockImplementation(
      async (_ws: string, opts?: { archived?: 'exclude' | 'only' | 'all' }) =>
        opts?.archived === 'only' ? [G_Z1, G_Z2] : [G_A],
    );
    mockApi.taskGroup.unarchive.mockReset().mockResolvedValue(G_Z1);
    mockApi.task.list.mockReset().mockResolvedValue([
      mkTask({ id: 't-x', title: '活跃任务', status: 'pending', groupId: 'g-a' }),
    ]);
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      loading: false,
      error: null,
      currentWorkspaceId: null,
      pendingMoveCount: 0,
      dragging: false,
    });
    useGroupStore.setState({
      groups: [],
      loading: false,
      error: null,
      currentWorkspaceId: null,
      selectedGroupId: null,
      selectedArchivedGroupId: null,
    });
    useWorkspaceStore.setState({
      workspaces: [WS],
      activeWorkspaceId: WS.id,
      loading: false,
      error: null,
    });
  });

  it('无归档组：分区整体不渲染（风琴头也不出现）', async () => {
    mockApi.taskGroup.list.mockImplementation(
      async (_ws: string, opts?: { archived?: 'exclude' | 'only' | 'all' }) =>
        opts?.archived === 'only' ? [] : [G_A],
    );
    render(<ArchivedGroupSection />);

    await waitFor(() => {
      expect(mockApi.taskGroup.list).toHaveBeenCalledWith('ws-1', { archived: 'only' });
    });
    expect(screen.queryByLabelText('已归档分组')).not.toBeInTheDocument();
  });

  it('默认折叠：风琴头渲染 + 计数，aria-expanded=false；组行不可见且零归档任务拉取', async () => {
    render(<ArchivedGroupSection />);
    const header = await screen.findByLabelText('已归档分组');

    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(within(header).getByText('已归档分组')).toBeInTheDocument();
    expect(within(header).getByText('(2)')).toBeInTheDocument();
    expect(header.querySelectorAll('svg').length).toBe(2);
    expect(screen.queryByLabelText('查看归档分组 归档组一')).not.toBeInTheDocument();
    expect(archivedOnlyTaskListCalls()).toBe(0);
  });

  it('展开分区：点风琴头后见归档组行与取消归档按钮；仍不发起归档任务拉取', async () => {
    render(<ArchivedGroupSection />);
    fireEvent.click(await screen.findByLabelText('已归档分组'));

    expect(screen.getByLabelText('已归档分组')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('查看归档分组 归档组一')).toBeInTheDocument();
    expect(screen.getByLabelText('查看归档分组 归档组二')).toBeInTheDocument();
    expect(screen.getByLabelText('取消归档 归档组一')).toBeInTheDocument();
    // 行结构与活跃组行（SortableGroupRow）同源：满宽选择按钮 + 右侧操作绝对
    // 定位叠加层（选中高亮含全行）；取消归档字号 text-xs（曾漏失致巨大字体）
    expect(screen.getByLabelText('查看归档分组 归档组一')).toHaveClass('w-full');
    expect(screen.getByLabelText('取消归档 归档组一')).toHaveClass('text-xs');
    expect(screen.getByLabelText('取消归档 归档组一')!.closest('div')).toHaveClass('absolute');
    expect(archivedOnlyTaskListCalls()).toBe(0);
  });

  it('组行点击 → selectedArchivedGroupId 置位 + aria-pressed + 活跃组同款高亮', async () => {
    render(<ArchivedGroupSection />);
    fireEvent.click(await screen.findByLabelText('已归档分组'));

    const row = screen.getByLabelText('查看归档分组 归档组一');
    expect(row).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(row);

    expect(useGroupStore.getState().selectedArchivedGroupId).toBe('g-z1');
    expect(screen.getByLabelText('查看归档分组 归档组一')).toHaveAttribute('aria-pressed', 'true');
    // 高亮与活跃组行同款（border-focus bg-surface-active text-primary 那套）
    expect(screen.getByLabelText('查看归档分组 归档组一')).toHaveClass(
      'border-focus',
      'bg-surface-active',
      'text-primary',
    );
    // 未选中的兄弟组行不高亮
    expect(screen.getByLabelText('查看归档分组 归档组二')).toHaveAttribute('aria-pressed', 'false');
    // 侧边栏零任务拉取语义：选中组行不发起任何归档任务拉取（展示移交主区）
    expect(archivedOnlyTaskListCalls()).toBe(0);
  });

  it('再点已选中的归档组行 → 取消选中（回 null，镜像活跃组 toggle 语义）', async () => {
    render(<ArchivedGroupSection />);
    fireEvent.click(await screen.findByLabelText('已归档分组'));

    fireEvent.click(screen.getByLabelText('查看归档分组 归档组一'));
    expect(useGroupStore.getState().selectedArchivedGroupId).toBe('g-z1');

    fireEvent.click(screen.getByLabelText('查看归档分组 归档组一'));
    expect(useGroupStore.getState().selectedArchivedGroupId).toBeNull();
    expect(screen.getByLabelText('查看归档分组 归档组一')).toHaveAttribute('aria-pressed', 'false');
  });

  it('选中归档组连带互斥清空 selectedGroupId（store 单点强制）', async () => {
    useGroupStore.setState({ selectedGroupId: 'g-a' });
    render(<ArchivedGroupSection />);
    fireEvent.click(await screen.findByLabelText('已归档分组'));

    fireEvent.click(screen.getByLabelText('查看归档分组 归档组一'));

    expect(useGroupStore.getState().selectedArchivedGroupId).toBe('g-z1');
    expect(useGroupStore.getState().selectedGroupId).toBeNull();
  });

  it('取消归档按钮不改变选中：点选后选中态保持，按钮结构隔离不触发选中切换', async () => {
    render(<ArchivedGroupSection />);
    fireEvent.click(await screen.findByLabelText('已归档分组'));

    fireEvent.click(screen.getByLabelText('查看归档分组 归档组一'));
    fireEvent.click(screen.getByLabelText('取消归档 归档组二'));

    await waitFor(() => {
      expect(mockApi.taskGroup.unarchive).toHaveBeenCalledWith('g-z2');
    });
    // 选中态不受兄弟按钮影响（仍是组一）
    expect(useGroupStore.getState().selectedArchivedGroupId).toBe('g-z1');
    expect(screen.getByLabelText('查看归档分组 归档组一')).toHaveAttribute('aria-pressed', 'true');
    // 取消归档链路（runUnarchive 级联刷新）不是归档任务拉取
    expect(archivedOnlyTaskListCalls()).toBe(0);
  });

  it('取消归档动作：调 taskGroup.unarchive + task.list 级联刷新', async () => {
    render(<ArchivedGroupSection />);
    fireEvent.click(await screen.findByLabelText('已归档分组'));

    fireEvent.click(screen.getByLabelText('取消归档 归档组一'));
    await waitFor(() => {
      expect(mockApi.taskGroup.unarchive).toHaveBeenCalledWith('g-z1');
    });
    await waitFor(() => {
      expect(mockApi.task.list).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'ws-1' }),
      );
    });
  });
});
