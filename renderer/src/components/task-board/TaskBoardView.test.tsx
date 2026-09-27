// renderer/src/components/task-board/TaskBoardView.test.tsx
//
// 看板主区测试（看板重构 Task 12 同步改造）：
//   - 未选中任务 → 标题栏 + BoardToolbar + 画板（五列 + 卡片）
//   - selectedTaskId → TaskDetailDrawer 右侧抽屉叠加（主区互斥渲染退役，
//     画板仍在）；泳道模式开关已接线（Task 12）+ localStorage 持久化 + 有组默认泳道
//   - 并发徽标（迁入 BoardToolbar，文案格式不变）：getGlobal 缺字段 fallback 3 /
//     返回 5 生效 / IPC 抛错兜底
// mock 边界：仅 mock IPC（window.api），store 用真实实现（momo-test-rules #5）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TaskBoardView } from './TaskBoardView';
import { useTaskStore } from '../../stores/task.store';
import { useGroupStore } from '../../stores/group.store';
import { useAgentStore } from '../../stores/agent.store';
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
  taskGroup: { list: vi.fn().mockResolvedValue([]) },
  // BoardCard→useTaskEntityNames 的兜底拉取：reject 走名称回退（不阻塞渲染）
  agent: { listMembers: vi.fn().mockRejectedValue(new Error('no ipc')) },
  team: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
  session: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
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
    ...partial,
  };
}

describe('TaskBoardView 主区（看板重构 Task 11）', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    window.localStorage.clear();
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      loading: false,
      error: null,
      // 预置当前 ws：防 load() 的 workspace 切换分支在首次 paint 前清空 fixture
      //（生产语义：切换 ws 才重置；同 ws 轮询刷新不吞本地态）
      currentWorkspaceId: 'ws-1',
    });
    // zustand 单例隔离：组/成员跨用例残留会污染画板 chip 与下拉选项
    useGroupStore.setState({ groups: [], loading: false, error: null, currentWorkspaceId: null });
    useAgentStore.setState({ members: [], teams: [] });
    mockApi.task.list.mockClear().mockResolvedValue([]);
    mockApi.task.get.mockClear().mockResolvedValue(null);
    mockApi.taskGroup.list.mockClear().mockResolvedValue([]);
    // 默认 settings.getGlobal 模拟后端现状：缺 maxConcurrentTasks 字段（fallback 测试）
    getGlobalMock.mockReset().mockResolvedValue({ maxToolCalls: 10, auditQuotaMb: 100 });
  });

  it('未选中任务时渲染工具栏 + 五列画板，任务卡进对应列', () => {
    const fixture = [mkTask({ id: 't1', title: '任务1', status: 'pending', priority: 5 })];
    mockApi.task.list.mockResolvedValue(fixture);
    useTaskStore.setState({ tasks: fixture });
    render(<TaskBoardView workspaceId="ws-1" />);
    expect(screen.getByText('任务看板')).toBeInTheDocument();
    // 工具栏：搜索 + 新建；泳道开关已接线（Task 12），归档入口已接线（Task 14）
    expect(screen.getByRole('textbox', { name: '搜索任务' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /新建任务/ })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /^分组$/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /归档/ })).toBeEnabled();
    // 五列（BOARD_COLUMNS 契约）
    for (const label of ['待办', '已分配', '进行中', '已完成', '已关闭']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // pending → 待办列
    expect(screen.getByText(/任务1/)).toBeInTheDocument();
  });

  it('文本过滤生效：不匹配的任务不出现在画板', () => {
    const fixture = [
      mkTask({ id: 't1', title: '_alpha 任务', status: 'pending', priority: 5 }),
      mkTask({ id: 't2', title: 'beta 任务', status: 'draft', priority: 5 }),
    ];
    mockApi.task.list.mockResolvedValue(fixture);
    useTaskStore.setState({ tasks: fixture });
    render(<TaskBoardView workspaceId="ws-1" />);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索任务' }), {
      target: { value: 'beta' },
    });
    expect(screen.getByText(/beta 任务/)).toBeInTheDocument();
    expect(screen.queryByText(/_alpha 任务/)).not.toBeInTheDocument();
  });

  it('selectedTaskId 非空 → TaskDetailDrawer 抽屉叠加，画板仍在（互斥渲染退役）', async () => {
    const task = mkTask({ id: 't1', title: '任务1', status: 'pending', priority: 5 });
    mockApi.task.get.mockResolvedValue(task);
    useTaskStore.setState({ tasks: [task], selectedTaskId: 't1' });
    render(<TaskBoardView workspaceId="ws-1" />);
    // 抽屉内 TaskDetailPanel 异步拉取 task.get 后渲染标题行
    expect(await screen.findByText(`#${task.id.slice(0, 8)}`)).toBeInTheDocument();
    // 画板与工具栏不被替换
    expect(screen.getByRole('textbox', { name: '搜索任务' })).toBeInTheDocument();
    expect(screen.getByText('待办')).toBeInTheDocument();
  });

  it('有活跃组且无持久化偏好 → 默认泳道模式（组名 heading 出现）', async () => {
    mockApi.taskGroup.list.mockResolvedValue([
      { id: 'G-1', workspaceId: 'ws-1', name: '泳道组', color: null, position: 1024, archivedAt: null, createdAt: 1, updatedAt: 1 },
    ]);
    render(<TaskBoardView workspaceId="ws-1" />);
    expect(await screen.findByRole('heading', { name: /泳道组/ })).toBeInTheDocument();
  });

  it('切换分组开关 → 泳道/平铺切换 + localStorage 持久化 key kanban-lane-mode', async () => {
    const fixture = [
      mkTask({ id: 't1', title: '组内任务', status: 'pending', priority: 5, groupId: 'G-1' }),
    ];
    mockApi.taskGroup.list.mockResolvedValue([
      { id: 'G-1', workspaceId: 'ws-1', name: '泳道组', color: null, position: 1024, archivedAt: null, createdAt: 1, updatedAt: 1 },
    ]);
    // 5s 轮询/首载返回同一 fixture——防 load 用空列表覆盖本地态
    mockApi.task.list.mockResolvedValue(fixture);
    useTaskStore.setState({ tasks: fixture });
    render(<TaskBoardView workspaceId="ws-1" />);
    // 有组默认 lanes
    expect(await screen.findByRole('heading', { name: /泳道组/ })).toBeInTheDocument();
    // 切回平铺：泳道 heading 消失（页面 h2 标题仍在）、卡片带组 chip
    fireEvent.click(screen.getByRole('switch', { name: /^分组$/ }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /泳道组/ })).not.toBeInTheDocument());
    expect(screen.getByText('泳道组')).toBeInTheDocument(); // chip 组名
    expect(window.localStorage.getItem('kanban-lane-mode')).toBe('flat');
    // 再切回泳道
    fireEvent.click(screen.getByRole('switch', { name: /^分组$/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /泳道组/ })).toBeInTheDocument());
    expect(window.localStorage.getItem('kanban-lane-mode')).toBe('lanes');
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
    const fixture = [
      mkTask({ id: 'i1', title: '执行中任务', status: 'in_progress', priority: 5 }),
      mkTask({ id: 'a1', title: '排队任务', status: 'assigned', priority: 5 }),
    ];
    mockApi.task.list.mockResolvedValue(fixture);
    useTaskStore.setState({ tasks: fixture });
    render(<TaskBoardView workspaceId="ws-1" />);
    expect(await screen.findByText(/并发.*1.*\/.*3.*排队.*1/)).toBeInTheDocument();
    expect(screen.getByText('任务看板')).toBeInTheDocument();
  });

  it('关闭按钮关闭详情面板 → 真实 store 的 selectedTaskId 置空', async () => {
    const task = mkTask({ id: 't1', title: '可点击任务', status: 'pending', priority: 5 });
    mockApi.task.get.mockResolvedValue(task);
    mockApi.task.list.mockResolvedValue([task]);
    useTaskStore.setState({ tasks: [task], selectedTaskId: 't1' });
    render(<TaskBoardView workspaceId="ws-1" />);
    expect(await screen.findByText('#t1')).toBeInTheDocument();
    // × 字形已 lucide 化（X + aria-label），语义查询按可访问名走
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(useTaskStore.getState().selectedTaskId).toBeNull();
  });
});
