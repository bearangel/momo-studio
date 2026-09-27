// renderer/src/components/task-board/TaskSidebarPanel.test.tsx
//
// 看板侧边栏面板测试（看板重构 Task 14 重构后；UX 修复：新建任务入口移除——
// 主区工具栏已有，侧边栏不再重复）：
//   - 三区块：分组管理（GroupManageList）/ 归档入口（计数）/ 远端节点（原样保留）
//   - 归档入口：mount 拉一次 task.list({archived:'only'}) 计数；点击打开 ArchivePanel
//   - 远端节点分区（P4 Task 3 原样保留回归）：节点卡 / 只读 / 空态 / stale
//   - 新建任务入口已退役：不再渲染 Plus 按钮 / CreateTaskDialog
//
// mock 边界：仅 mock window.api；task.store / group.store / workspace.store 真实实现。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TaskSidebarPanel } from './TaskSidebarPanel';
import { useTaskStore } from '../../stores/task.store';
import { useGroupStore } from '../../stores/group.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { TaskRow, Workspace, RemoteNodeTasks, GroupRow } from '../../ipc/types';

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
    boardPosition: null,
    archivedAt: null,
    priority: 5,
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

const ARCHIVED_TASKS = [
  mkTask({ id: 'T-a1', title: '归档一', status: 'completed', archivedAt: 1 }),
  mkTask({ id: 'T-a2', title: '归档二', status: 'failed', archivedAt: 2 }),
];

const mockApi = {
  task: {
    list: vi.fn(),
  },
  taskGroup: {
    list: vi.fn(),
  },
  p2p: {
    getRemoteTasks: vi.fn().mockResolvedValue([]),
  },
};

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

function setupStores(): void {
  useTaskStore.setState({
    tasks: [mkTask({ id: 'task-a', title: '任务A', status: 'in_progress' })],
    selectedTaskId: null,
    loading: false,
    error: null,
  });
  useGroupStore.setState({ groups: [], loading: false, error: null, currentWorkspaceId: null });
  useWorkspaceStore.setState({
    workspaces: [WS],
    activeWorkspaceId: WS.id,
    loading: false,
    error: null,
  });
}

describe('TaskSidebarPanel（Task 14 重构：分组管理 + 归档入口 + 远端节点）', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    setupStores();
    mockApi.task.list.mockReset().mockResolvedValue(ARCHIVED_TASKS);
    // taskGroup.list 两态：默认活跃组；archived:'only' 无归档组（折叠区不渲染）
    mockApi.taskGroup.list.mockReset().mockImplementation(
      async (_ws: string, opts?: { archived?: 'exclude' | 'only' | 'all' }) =>
        opts?.archived === 'only' ? [] : [mkGroup({ id: 'g-1', name: '组一' })],
    );
    mockApi.p2p.getRemoteTasks.mockReset().mockResolvedValue([]);
  });

  it('三区块存在：分组管理 / 归档入口 / 远端节点', async () => {
    mockApi.p2p.getRemoteTasks.mockResolvedValue([mkRemote()]);
    render(<TaskSidebarPanel />);

    // 分组管理区块（GroupManageList 挂载 + 组行渲染）
    expect(screen.getByLabelText('分组管理')).toBeInTheDocument();
    expect(await screen.findByLabelText('分组 组一')).toBeInTheDocument();
    // 归档入口
    expect(screen.getByRole('button', { name: /归档/ })).toBeInTheDocument();
    // 远端节点分区
    expect(await screen.findByText('远端节点')).toBeInTheDocument();
    expect(screen.getByText('节点B')).toBeInTheDocument();
  });

  it('归档入口显示归档计数：mount 拉一次 task.list({archived:"only"})', async () => {
    render(<TaskSidebarPanel />);

    await waitFor(() => {
      expect(mockApi.task.list).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        archived: 'only',
        limit: 500,
      });
    });
    // 计数 = 归档任务数（2）
    expect(await screen.findByRole('button', { name: '归档 2' })).toBeInTheDocument();
  });

  it('点归档入口打开 ArchivePanel（大号弹窗 + 归档行渲染）', async () => {
    render(<TaskSidebarPanel />);
    fireEvent.click(await screen.findByRole('button', { name: '归档 2' }));

    expect(await screen.findByRole('dialog', { name: '归档任务' })).toBeInTheDocument();
    expect(await screen.findByText(/归档一/)).toBeInTheDocument();
  });

  it('新建任务入口已退役：无 Plus 按钮、不渲染创建任务对话框', () => {
    render(<TaskSidebarPanel />);
    expect(screen.queryByLabelText('新建任务')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '创建任务' })).not.toBeInTheDocument();
  });
});

describe('TaskSidebarPanel 远端节点分区（P4 Task 3 只读镜像，原样保留）', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    setupStores();
    mockApi.task.list.mockReset().mockResolvedValue([]);
    mockApi.taskGroup.list.mockReset().mockResolvedValue([]);
    mockApi.p2p.getRemoteTasks.mockReset().mockResolvedValue([]);
  });

  it('远端非空时渲染：节点名 + 相对时间 + 只读任务行（id/标题/状态徽标）', async () => {
    mockApi.p2p.getRemoteTasks.mockResolvedValue([
      mkRemote({ nodeName: '节点B', takenAt: Date.now() - 30_000 }),
    ]);
    render(<TaskSidebarPanel />);

    expect(await screen.findByText('远端节点')).toBeInTheDocument();
    expect(screen.getByText('节点B')).toBeInTheDocument();
    expect(screen.getByText('30 秒前')).toBeInTheDocument();
    // 只读任务行（非按钮）
    expect(screen.getByText('#T-901 · 远端任务甲')).toBeInTheDocument();
    expect(screen.getByText('待分配')).toBeInTheDocument();
  });

  it('只读分区无任何操作按钮：节点名/任务行都不是按钮', async () => {
    mockApi.p2p.getRemoteTasks.mockResolvedValue([mkRemote()]);
    render(<TaskSidebarPanel />);

    await screen.findByText('远端节点');
    expect(screen.queryByRole('button', { name: /远端任务甲/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^节点B$/ })).not.toBeInTheDocument();
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
