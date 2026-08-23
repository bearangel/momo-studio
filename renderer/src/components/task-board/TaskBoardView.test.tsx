// renderer/src/components/task-board/TaskBoardView.test.tsx
//
// 看板主区拆分测试（P2 Task 3）：TaskFilters/TaskList 迁去侧边栏后，
// 主区 = 顶部状态栏 + selectedTaskId ? TaskDetailPanel : 空态「从左侧选择任务」。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskBoardView } from './TaskBoardView';
import { useTaskStore } from '../../stores/task.store';
import type { TaskRow } from '../../ipc/types';

const mockApi = {
  task: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
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

describe('TaskBoardView 主区（拆分后）', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      loading: false,
      error: null,
    });
    mockApi.task.list.mockClear().mockResolvedValue([]);
    mockApi.task.get.mockClear().mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('未选中任务时显示状态栏 + 空态提示，不渲染任务列表/筛选条', () => {
    useTaskStore.setState({
      tasks: [mkTask({ id: 't1', title: '任务1', status: 'pending', priority: 5 })],
    });
    render(<TaskBoardView workspaceId="ws-1" />);
    expect(screen.getByText('任务看板')).toBeInTheDocument();
    expect(screen.getByText('从左侧选择任务')).toBeInTheDocument();
    // 筛选条与任务列表已迁入侧边栏（TaskSidebarPanel），主区不再渲染
    expect(screen.queryByDisplayValue('全部状态')).not.toBeInTheDocument();
    expect(screen.queryByText('任务1')).not.toBeInTheDocument();
  });

  it('selectedTaskId 非空时渲染 TaskDetailPanel', async () => {
    const task = mkTask({ id: 't1', title: '任务1', status: 'pending', priority: 5 });
    mockApi.task.get.mockResolvedValue(task);
    useTaskStore.setState({ tasks: [task], selectedTaskId: 't1' });
    render(<TaskBoardView workspaceId="ws-1" />);
    // TaskDetailPanel 异步拉取 task.get 后渲染标题行
    expect(await screen.findByText(`#${task.id.slice(0, 8)}`)).toBeInTheDocument();
    expect(screen.queryByText('从左侧选择任务')).not.toBeInTheDocument();
  });
});
