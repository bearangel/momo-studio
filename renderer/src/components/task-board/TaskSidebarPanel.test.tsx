// renderer/src/components/task-board/TaskSidebarPanel.test.tsx
//
// 看板侧边栏面板测试（看板重构 Task 14 重构后；UX 修复：新建任务入口移除——
// 主区工具栏已有，侧边栏不再重复）：
//   - 两区块：分组管理（GroupManageList）/ 归档入口（计数）
//   - 归档入口：mount 拉一次 task.list({archived:'only'}) 计数；点击打开 ArchivePanel
//
// mock 边界：仅 mock window.api；task.store / group.store / workspace.store 真实实现。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TaskSidebarPanel } from './TaskSidebarPanel';
import { useTaskStore } from '../../stores/task.store';
import { useGroupStore } from '../../stores/group.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { TaskRow, Workspace, GroupRow } from '../../ipc/types';

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
    pinnedAt: null,
    archivedAt: null,
    routing: { mode: 'local' }, delegationId: null, parentTaskId: null,
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
};

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

describe('TaskSidebarPanel（Task 14 重构：分组管理 + 归档入口）', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    setupStores();
    mockApi.task.list.mockReset().mockResolvedValue(ARCHIVED_TASKS);
    // taskGroup.list 两态：默认活跃组；archived:'only' 无归档组（折叠区不渲染）
    mockApi.taskGroup.list.mockReset().mockImplementation(
      async (_ws: string, opts?: { archived?: 'exclude' | 'only' | 'all' }) =>
        opts?.archived === 'only' ? [] : [mkGroup({ id: 'g-1', name: '组一' })],
    );
  });

  it('两区块存在：分组管理 / 归档入口', async () => {
    render(<TaskSidebarPanel />);

    // 分组管理区块（GroupManageList 挂载 + 组行渲染）
    expect(screen.getByLabelText('分组管理')).toBeInTheDocument();
    expect(await screen.findByLabelText('分组 组一')).toBeInTheDocument();
    // 归档入口
    expect(screen.getByRole('button', { name: /归档/ })).toBeInTheDocument();
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

