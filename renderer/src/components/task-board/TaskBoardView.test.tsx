// renderer/src/components/task-board/TaskBoardView.test.tsx
//
// 看板主区拆分测试（P2 Task 3）：TaskFilters/TaskList 迁去侧边栏后，
// 主区 = 顶部状态栏 + selectedTaskId ? TaskDetailPanel : 空态「从左侧选择任务」。
// 并发上限（P1）接 settings.getGlobal 返回的 maxConcurrentTasks，缺字段 fallback 3。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TaskBoardView } from './TaskBoardView';
import { useTaskStore } from '../../stores/task.store';
import type { TaskRow } from '../../ipc/types';

const getGlobalMock = vi.fn();

const mockApi = {
  task: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
  },
  settings: {
    getGlobal: getGlobalMock,
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
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      loading: false,
      error: null,
    });
    mockApi.task.list.mockClear().mockResolvedValue([]);
    mockApi.task.get.mockClear().mockResolvedValue(null);
    // 默认 settings.getGlobal 模拟后端现状：缺 maxConcurrentTasks 字段（fallback 测试）
    getGlobalMock.mockReset().mockResolvedValue({ maxToolCalls: 10, auditQuotaMb: 100 });
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

  it('settings.getGlobal 缺 maxConcurrentTasks 字段 → 状态栏显示 fallback 3', async () => {
    mockApi.task.list.mockResolvedValue([
      mkTask({ id: 'i1', title: '执行中', status: 'in_progress', priority: 5 }),
      mkTask({ id: 'a1', title: '已分配', status: 'assigned', priority: 5 }),
    ]);
    render(<TaskBoardView workspaceId="ws-1" />);
    expect(await screen.findByText(/并发: 1\/3/)).toBeInTheDocument();
  });

  it('settings.getGlobal 返回 maxConcurrentTasks=5 → 状态栏显示 5（U2 接全局生效）', async () => {
    getGlobalMock.mockResolvedValue({ maxConcurrentTasks: 5, maxToolCalls: 10, auditQuotaMb: 100 });
    mockApi.task.list.mockResolvedValue([
      mkTask({ id: 'i1', title: '执行中', status: 'in_progress', priority: 5 }),
      mkTask({ id: 'i2', title: '执行中', status: 'in_progress', priority: 5 }),
    ]);
    render(<TaskBoardView workspaceId="ws-1" />);
    expect(await screen.findByText(/并发: 2\/5/)).toBeInTheDocument();
  });

  it('settings.getGlobal 抛错 → 状态栏仍显示 fallback 3，UI 不崩溃', async () => {
    getGlobalMock.mockRejectedValue(new Error('IPC 异常'));
    mockApi.task.list.mockResolvedValue([
      mkTask({ id: 'i1', title: '执行中', status: 'in_progress', priority: 5 }),
    ]);
    render(<TaskBoardView workspaceId="ws-1" />);
    expect(await screen.findByText(/并发: 1\/3/)).toBeInTheDocument();
  });

  // —— 以下两用例自 renderer/tests/components/task-board/TaskBoardView.test.tsx 迁入
  // （2026-08 目录规范统一），并按 momo-test-rules #5 从 vi.mock(store) 移植到真实 store：
  // mock 越薄测试离生产越近；关闭回调断言 store 真实状态而非 mock 调用记录。
  it('状态栏并发徽标含排队计数（store tasks 派生）', async () => {
    useTaskStore.setState({
      tasks: [
        mkTask({ id: 'i1', title: '执行中任务', status: 'in_progress', priority: 5 }),
        mkTask({ id: 'a1', title: '排队任务', status: 'assigned', priority: 5 }),
      ],
    });
    render(<TaskBoardView workspaceId="ws-1" />);
    expect(await screen.findByText(/并发.*1.*\/.*3.*排队.*1/)).toBeInTheDocument();
    expect(screen.getByText('任务看板')).toBeInTheDocument();
  });

  it('关闭按钮关闭详情面板 → 真实 store 的 selectedTaskId 置空', async () => {
    const task = mkTask({ id: 't1', title: '可点击任务', status: 'pending', priority: 5 });
    mockApi.task.get.mockResolvedValue(task);
    useTaskStore.setState({ tasks: [task], selectedTaskId: 't1' });
    render(<TaskBoardView workspaceId="ws-1" />);
    expect(await screen.findByText('#t1')).toBeInTheDocument();
    // × 字形已 lucide 化（X + aria-label），语义查询按可访问名走
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(useTaskStore.getState().selectedTaskId).toBeNull();
  });
});
