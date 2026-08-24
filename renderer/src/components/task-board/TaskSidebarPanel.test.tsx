// renderer/src/components/task-board/TaskSidebarPanel.test.tsx
//
// 看板侧边栏面板测试（P2 Task 3）：TaskFilters + TaskList + 新建任务按钮从
// TaskBoardView 整体迁入侧边栏后的回归——筛选/排序逻辑等价迁移。
// - 渲染：新建任务按钮 + 三个筛选 select + 任务卡片
// - 筛选：状态过滤；排序：priority / created_at
// - 点击任务 → task.store.selectedTaskId
// - 新建任务 → 打开 CreateTaskDialog（onCreated 选中新建任务）
//
// P4 Task 3 追加：底部「远端节点」只读分区——
// - 渲染：节点分组卡（节点名 + 相对时间 + 只读任务行 id/标题/状态徽标）
// - 只读：任务行不是按钮、不新增任何操作按钮
// - 空：getRemoteTasks 返回空时不渲染分区
// - stale：超时快照带「已离线?」标记
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { TaskSidebarPanel } from './TaskSidebarPanel';
import { useTaskStore } from '../../stores/task.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { TaskRow, Workspace, RemoteNodeTasks } from '../../ipc/types';

const mockApi = {
  agent: {
    listAssignments: vi.fn().mockResolvedValue([]),
  },
  task: {
    create: vi.fn(),
  },
  p2p: {
    getRemoteTasks: vi.fn().mockResolvedValue([]),
  },
};

function mkTask(partial: Partial<TaskRow> & Pick<TaskRow, 'id' | 'title' | 'status' | 'priority'>): TaskRow {
  return {
    workspaceId: 'ws-1',
    description: '',
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'user-1',
    executionSessionId: null,
    assigneeAgentId: null,
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
    ...partial,
  };
}

const WS: Workspace = {
  id: 'ws-1',
  name: 'ws',
  description: '',
  directoryPath: '/tmp/ws',
  teamSessionId: 'sess-1',
  gitInitialized: false,
  createdAt: '2026-01-01T00:00:00Z',
  ownerId: 'owner',
  iconEmoji: '📁',
  coordinatorInstanceId: null,
};

const TASK_A = mkTask({ id: 'task-a', title: '任务A', status: 'in_progress', priority: 5, createdAt: 3000 });
const TASK_B = mkTask({ id: 'task-b', title: '任务B', status: 'assigned', priority: 10, createdAt: 1000 });
const TASK_C = mkTask({ id: 'task-c', title: '任务C', status: 'in_progress', priority: 1, createdAt: 2000 });

/** 按钮 accessible name 形如「[中]#task-a · 任务A」，用标题正则定位 */
function taskButton(title: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(title) });
}

/** 全部任务卡片标题（DOM 顺序） */
function taskOrder(): string[] {
  return screen
    .getAllByRole('button', { name: /#[a-z0-9-]+ · 任务/ })
    .map((el) => el.textContent?.match(/(任务[ABC])/)?.[1] ?? '');
}

/** 远端任务行 fixture（RemoteNodeTasks.tasks 元素形状） */
const REMOTE_TASK: RemoteNodeTasks['tasks'][number] = {
  id: 'T-901',
  title: '远端任务甲',
  status: 'pending',
  assigneeAgentId: null,
  priority: 5,
  createdAt: 1000,
  updatedAt: 2000,
};

function mkRemote(partial: Partial<RemoteNodeTasks> = {}): RemoteNodeTasks {
  return {
    nodeId: 'node-b',
    nodeName: '节点B',
    tasks: [REMOTE_TASK],
    takenAt: Date.now(),
    stale: false,
    ...partial,
  };
}

describe('TaskSidebarPanel', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useTaskStore.setState({
      tasks: [TASK_A, TASK_B, TASK_C],
      selectedTaskId: null,
      loading: false,
      error: null,
    });
    useWorkspaceStore.setState({
      workspaces: [WS],
      activeWorkspaceId: WS.id,
      loading: false,
      error: null,
    });
    mockApi.agent.listAssignments.mockClear().mockResolvedValue([]);
    mockApi.task.create.mockReset();
    mockApi.p2p.getRemoteTasks.mockReset().mockResolvedValue([]);
  });

  it('渲染新建任务按钮 + 筛选条 + 全部任务（默认按优先级降序）', () => {
    render(<TaskSidebarPanel />);
    expect(screen.getByLabelText('新建任务')).toBeInTheDocument();
    expect(taskButton('任务A')).toBeInTheDocument();
    expect(taskButton('任务B')).toBeInTheDocument();
    expect(taskButton('任务C')).toBeInTheDocument();
    // 默认 sort=priority：B(10) → A(5) → C(1)
    expect(taskOrder()).toEqual(['任务B', '任务A', '任务C']);
  });

  it('状态筛选：执行中 只剩 in_progress 任务', () => {
    render(<TaskSidebarPanel />);
    fireEvent.change(screen.getByDisplayValue('全部状态'), {
      target: { value: 'in_progress' },
    });
    expect(taskButton('任务A')).toBeInTheDocument();
    expect(taskButton('任务C')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /任务B/ })).not.toBeInTheDocument();
  });

  it('排序切换：按创建时间（升序）', () => {
    render(<TaskSidebarPanel />);
    fireEvent.change(screen.getByDisplayValue('按优先级'), {
      target: { value: 'created_at' },
    });
    expect(taskOrder()).toEqual(['任务B', '任务C', '任务A']);
  });

  it('点击任务卡片 → task.store.selectedTaskId 更新', () => {
    render(<TaskSidebarPanel />);
    fireEvent.click(taskButton('任务B'));
    expect(useTaskStore.getState().selectedTaskId).toBe('task-b');
  });

  it('点击 ＋ 打开创建任务对话框', () => {
    render(<TaskSidebarPanel />);
    fireEvent.click(screen.getByLabelText('新建任务'));
    expect(screen.getByRole('heading', { name: '创建任务' })).toBeInTheDocument();
  });

  it('创建成功后 onCreated 选中新建任务', async () => {
    const created = mkTask({ id: 'task-new', title: '新任务', status: 'draft', priority: 5 });
    mockApi.task.create.mockResolvedValue(created);
    render(<TaskSidebarPanel />);
    fireEvent.click(screen.getByLabelText('新建任务'));
    fireEvent.change(screen.getByLabelText('标题*'), {
      target: { value: '新任务' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => {
      expect(useTaskStore.getState().selectedTaskId).toBe('task-new');
    });
  });
});

describe('TaskSidebarPanel 远端节点分区（P4 Task 3 只读镜像）', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useTaskStore.setState({
      tasks: [TASK_A, TASK_B, TASK_C],
      selectedTaskId: null,
      loading: false,
      error: null,
    });
    useWorkspaceStore.setState({
      workspaces: [WS],
      activeWorkspaceId: WS.id,
      loading: false,
      error: null,
    });
    mockApi.agent.listAssignments.mockClear().mockResolvedValue([]);
    mockApi.task.create.mockReset();
    mockApi.p2p.getRemoteTasks.mockReset().mockResolvedValue([]);
  });

  it('远端非空时渲染：分区标题 + 节点名 + 相对时间 + 只读任务行（id/标题/状态徽标）', async () => {
    mockApi.p2p.getRemoteTasks.mockResolvedValue([
      mkRemote({ nodeName: '节点B', takenAt: Date.now() - 30_000 }),
    ]);
    render(<TaskSidebarPanel />);

    expect(await screen.findByText('远端节点')).toBeInTheDocument();
    expect(screen.getByText('节点B')).toBeInTheDocument();
    expect(screen.getByText('30 秒前')).toBeInTheDocument();
    // 状态徽标挂在远端任务行内（TaskFilters 下拉也有同名 option，须按行 scope）
    const row = screen.getByText('#T-901 · 远端任务甲').parentElement as HTMLElement;
    expect(within(row).getByText('待启动')).toBeInTheDocument();
  });

  it('只读分区无任何操作按钮：节点名/任务行都不是按钮', async () => {
    mockApi.p2p.getRemoteTasks.mockResolvedValue([mkRemote()]);
    render(<TaskSidebarPanel />);

    await screen.findByText('远端节点');
    // 本地任务行是 button（taskButton 定位）；远端行绝不能是——只读铁律
    expect(screen.queryByRole('button', { name: /远端任务甲/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /节点B/ })).not.toBeInTheDocument();
  });

  it('远端为空时不渲染分区', async () => {
    mockApi.p2p.getRemoteTasks.mockResolvedValue([]);
    render(<TaskSidebarPanel />);

    await waitFor(() => {
      expect(mockApi.p2p.getRemoteTasks).toHaveBeenCalled();
    });
    expect(screen.queryByText('远端节点')).not.toBeInTheDocument();
  });

  it('stale 快照显示「已离线?」标记', async () => {
    mockApi.p2p.getRemoteTasks.mockResolvedValue([
      mkRemote({ stale: true, takenAt: Date.now() - 2 * 60_000 }),
    ]);
    render(<TaskSidebarPanel />);

    expect(await screen.findByText('已离线?')).toBeInTheDocument();
    expect(screen.getByText('2 分钟前')).toBeInTheDocument();
  });
});
