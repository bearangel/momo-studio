// renderer/tests/components/task-board/TaskBoardView.test.tsx
//
// TaskBoardView 集成测试（P2 Task 3 拆分后）：
//   1. 渲染顶部标题"任务看板" + 并发状态徽标（从 tasks 本地派生）
//   2. 未选中任务 → 主区空态"从左侧选择任务"，不渲染筛选条/任务列表
//   3. selectedTaskId 非空 → 渲染 TaskDetailPanel（task.get 拉取），
//      × 关闭回调 setSelectedTaskId(null)
//
// 筛选/排序/点击选中已随 TaskFilters/TaskList 迁入侧边栏，由
// src/components/task-board/TaskSidebarPanel.test.tsx 覆盖。
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
const mockSetSelected = vi.fn();
/** 测试注入的选中任务（store mock 无订阅，渲染前赋值即可） */
let mockSelectedTaskId: string | null = null;

vi.mock('../../../src/stores/task.store', () => ({
  useTaskStore: <T,>(selector?: (s: {
    tasks: TaskRow[];
    load: typeof mockLoad;
    selectedTaskId: string | null;
    setSelectedTaskId: typeof mockSetSelected;
  }) => T): T | {
    tasks: TaskRow[];
    load: typeof mockLoad;
    selectedTaskId: string | null;
    setSelectedTaskId: typeof mockSetSelected;
  } => {
    const state = {
      tasks: mockTasks() as TaskRow[],
      load: mockLoad,
      selectedTaskId: mockSelectedTaskId,
      setSelectedTaskId: mockSetSelected,
    };
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
    // v2.0.1 组件 mount 拉取全局并发上限——空对象 = 字段缺失走 fallback 3，
    // 与旧用例「并发: x/3」断言一致
    settings: {
      getGlobal: vi.fn().mockResolvedValue({}),
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
    mockSetSelected.mockReset();
    mockSelectedTaskId = null;
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

  it('未选中任务时主区为空态"从左侧选择任务"，不渲染筛选条与任务列表', () => {
    mockTasks.mockReturnValue([
      makeTask({ id: 'T-001', title: '实现登录', status: 'in_progress' }),
    ]);
    render(<TaskBoardView workspaceId="ws1" />);
    expect(screen.getByText('从左侧选择任务')).toBeInTheDocument();
    expect(screen.queryByText(/实现登录/)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('全部状态')).not.toBeInTheDocument();
  });

  it('selectedTaskId 非空时渲染详情面板，× 关闭调 setSelectedTaskId(null)', async () => {
    const task = makeTask({ id: 'T-001', title: '可点击任务', status: 'pending' });
    mockTasks.mockReturnValue([task]);
    mockTaskGet.mockResolvedValue(task);
    mockSelectedTaskId = 'T-001';
    render(<TaskBoardView workspaceId="ws1" />);

    await waitFor(() => {
      expect(screen.getByText(/#T-001/)).toBeInTheDocument();
    });
    expect(mockTaskGet).toHaveBeenCalledWith('T-001');

    fireEvent.click(screen.getByRole('button', { name: '×' }));
    expect(mockSetSelected).toHaveBeenCalledWith(null);
  });
});
