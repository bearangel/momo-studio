// renderer/tests/components/task-board/TaskBoardView.test.tsx
//
// TaskBoardView 集成测试（D 子系统 D7-D10）：
//   1. 渲染顶部标题"任务看板" + 并发状态徽标（从 tasks 本地派生）
//   2. 渲染任务列表（TaskCard 展示 #ID · 标题）
//   3. 空态显示"暂无任务"
//   4. 状态筛选：选"执行中"只留 in_progress 任务
//   5. 点击任务卡片打开详情侧滑面板
//
// mock 策略：
//   - task.store：useTaskStore 支持选择器调用 useTaskStore((s) => s.xxx)，
//     也支持无选择器调用 useTaskStore()。用 factory 包一层。
//   - ipc/client：task.get / task.start / task.cancel 返回 resolved promise。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { TaskRow } from '../../../src/ipc/types';

// ---- mock task.store（支持选择器 + 无选择器两种调用形式）----
const mockTasks = vi.fn();
const mockLoad = vi.fn();

vi.mock('../../../src/stores/task.store', () => ({
  useTaskStore: <T,>(selector?: (s: { tasks: TaskRow[]; load: typeof mockLoad }) => T): T | { tasks: TaskRow[]; load: typeof mockLoad } => {
    const state = { tasks: mockTasks() as TaskRow[], load: mockLoad };
    return selector ? selector(state) : state;
  },
}));

// ---- mock ipc/client ----
const mockTaskGet = vi.fn();
const mockTaskStart = vi.fn();
const mockTaskCancel = vi.fn();
vi.mock('../../../src/ipc/client', () => ({
  ipc: {
    task: {
      get: (id: string) => mockTaskGet(id),
      start: mockTaskStart,
      cancel: mockTaskCancel,
    },
  },
}));

const { TaskBoardView } = await import('../../../src/components/task-board/TaskBoardView');

/** 构造一条 TaskRow 测试夹具 */
function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'T-000001',
    workspaceId: 'ws1',
    title: '示例任务',
    description: '',
    status: 'pending',
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'u1',
    executionSessionId: null,
    assigneeAgentId: null,
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
    ...overrides,
  };
}

describe('TaskBoardView', () => {
  beforeEach(() => {
    mockTasks.mockReset();
    mockLoad.mockReset();
    mockTaskGet.mockReset();
    mockTaskStart.mockReset();
    mockTaskCancel.mockReset();
    mockLoad.mockResolvedValue(undefined);
  });

  it('渲染顶部标题 + 并发状态徽标', () => {
    mockTasks.mockReturnValue([
      makeTask({ id: 'T-001', status: 'in_progress', title: '执行中任务' }),
      makeTask({ id: 'T-002', status: 'assigned', title: '排队任务' }),
    ]);
    render(<TaskBoardView workspaceId="ws1" />);
    expect(screen.getByText('任务看板')).toBeInTheDocument();
    // 并发：active(1)/max(3)　排队: 1
    expect(screen.getByText(/并发.*1.*\/.*3.*排队.*1/)).toBeInTheDocument();
  });

  it('渲染任务列表中的任务标题', () => {
    mockTasks.mockReturnValue([
      makeTask({ id: 'T-001', title: '实现登录', status: 'in_progress' }),
    ]);
    render(<TaskBoardView workspaceId="ws1" />);
    expect(screen.getByText(/实现登录/)).toBeInTheDocument();
  });

  it('空态显示"暂无任务"', () => {
    mockTasks.mockReturnValue([]);
    render(<TaskBoardView workspaceId="ws1" />);
    expect(screen.getByText('暂无任务')).toBeInTheDocument();
  });

  it('状态筛选：选"执行中"只留 in_progress 任务', () => {
    mockTasks.mockReturnValue([
      makeTask({ id: 'T-001', title: '执行中任务', status: 'in_progress' }),
      makeTask({ id: 'T-002', title: '待启动任务', status: 'pending' }),
    ]);
    render(<TaskBoardView workspaceId="ws1" />);
    // 初始两条都可见
    expect(screen.getByText(/执行中任务/)).toBeInTheDocument();
    expect(screen.getByText(/待启动任务/)).toBeInTheDocument();
    // 选择状态筛选 = 执行中
    const statusSelect = screen.getAllByRole('combobox')[0]!;
    fireEvent.change(statusSelect, { target: { value: 'in_progress' } });
    expect(screen.getByText(/执行中任务/)).toBeInTheDocument();
    expect(screen.queryByText(/待启动任务/)).not.toBeInTheDocument();
  });

  it('点击任务卡片打开详情面板', async () => {
    const task = makeTask({ id: 'T-001', title: '可点击任务', status: 'pending' });
    mockTasks.mockReturnValue([task]);
    mockTaskGet.mockResolvedValue(task);
    render(<TaskBoardView workspaceId="ws1" />);
    // 点击任务卡片按钮
    fireEvent.click(screen.getByText(/可点击任务/));
    // 详情面板出现（标题行 #T-001...）
    await waitFor(() => {
      expect(screen.getByText(/#T-001/)).toBeInTheDocument();
    });
    expect(mockTaskGet).toHaveBeenCalledWith('T-001');
  });
});
