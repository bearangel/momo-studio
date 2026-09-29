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
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
    useGroupStore.setState({
      groups: [],
      loading: false,
      error: null,
      currentWorkspaceId: null,
      selectedGroupId: null,
      selectedArchivedGroupId: null,
    });
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
    // 泳道开关已改 pill toggle（UX 修复）：aria-pressed 语义查询
    const laneToggle = screen.getByRole('button', { name: /^分组$/ });
    expect(laneToggle).toBeEnabled();
    expect(laneToggle).toHaveAttribute('aria-pressed', 'false');
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

  // UX 修复回归锁：点侧边栏组行 → 看板只显示该组；selectedGroupId 悬空（组已
  // 不在活跃集合）时视为未选中，不死过滤
  it('selectedGroupId 置位 → 泳道只渲染被选组、他组任务不出现', async () => {
    const fixture = [
      mkTask({ id: 't1', title: '一组任务', status: 'pending', priority: 5, groupId: 'G-1' }),
      mkTask({ id: 't2', title: '二组任务', status: 'pending', priority: 5, groupId: 'G-2' }),
    ];
    const groupRows = [
      { id: 'G-1', workspaceId: 'ws-1', name: '泳道组一', color: null, position: 1024, archivedAt: null, createdAt: 1, updatedAt: 1 },
      { id: 'G-2', workspaceId: 'ws-1', name: '泳道组二', color: null, position: 2048, archivedAt: null, createdAt: 2, updatedAt: 2 },
    ];
    mockApi.taskGroup.list.mockResolvedValue(groupRows);
    mockApi.task.list.mockResolvedValue(fixture);
    // 预置当前 ws：防 group.store load 的切换分支在首次 paint 前清空 fixture
    useTaskStore.setState({ tasks: fixture, currentWorkspaceId: 'ws-1' });
    useGroupStore.setState({ groups: groupRows, currentWorkspaceId: 'ws-1', selectedGroupId: 'G-1' });
    render(<TaskBoardView workspaceId="ws-1" />);

    // 只剩被选组的泳道 heading；他组泳道与其任务被过滤
    expect(await screen.findByRole('heading', { name: /泳道组一/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /泳道组二/ })).not.toBeInTheDocument();
    expect(screen.getByText(/一组任务/)).toBeInTheDocument();
    expect(screen.queryByText(/二组任务/)).not.toBeInTheDocument();
  });

  it('selectedGroupId 指向不存在的组 → 视为未选中（全部泳道照常渲染）', async () => {
    const fixture = [
      mkTask({ id: 't1', title: '一组任务', status: 'pending', priority: 5, groupId: 'G-1' }),
    ];
    const groupRows = [
      { id: 'G-1', workspaceId: 'ws-1', name: '泳道组一', color: null, position: 1024, archivedAt: null, createdAt: 1, updatedAt: 1 },
    ];
    mockApi.taskGroup.list.mockResolvedValue(groupRows);
    mockApi.task.list.mockResolvedValue(fixture);
    useTaskStore.setState({ tasks: fixture, currentWorkspaceId: 'ws-1' });
    // G-gone 不在活跃组集合（如已被归档）：过滤悬空不吞任务
    useGroupStore.setState({ groups: groupRows, currentWorkspaceId: 'ws-1', selectedGroupId: 'G-gone' });
    render(<TaskBoardView workspaceId="ws-1" />);

    expect(await screen.findByRole('heading', { name: /泳道组一/ })).toBeInTheDocument();
    expect(screen.getByText(/一组任务/)).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: /^分组$/ })).toHaveAttribute('aria-pressed', 'true');
    // 切回平铺：泳道 heading 消失（页面 h2 标题仍在）、卡片带组 chip
    fireEvent.click(screen.getByRole('button', { name: /^分组$/ }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /泳道组/ })).not.toBeInTheDocument());
    expect(screen.getByText('泳道组')).toBeInTheDocument(); // chip 组名
    expect(window.localStorage.getItem('kanban-lane-mode')).toBe('flat');
    // 再切回泳道
    fireEvent.click(screen.getByRole('button', { name: /^分组$/ }));
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

  // —— 归档视图分支（归档组点击 → 主区只读看板改造）——

  /** 归档视图 fixture：归档组 + 该组归档任务（taskGroup.list / task.list 两态 mock） */
  function setupArchivedView(): void {
    const archivedGroup = {
      id: 'g-z1',
      workspaceId: 'ws-1',
      name: '归档组一',
      color: null,
      position: 1024,
      archivedAt: 111,
      createdAt: 1,
      updatedAt: 1,
    };
    const archivedTasks = [
      mkTask({
        id: 'tz1',
        title: '归档任务甲',
        status: 'completed',
        priority: 5,
        groupId: 'g-z1',
        archivedAt: 999,
      }),
      mkTask({
        id: 'tz2',
        title: '归档任务乙',
        status: 'pending',
        priority: 5,
        groupId: 'g-z1',
        archivedAt: 888,
      }),
    ];
    const activeTask = mkTask({ id: 't9', title: '活跃任务九', status: 'pending', priority: 5 });
    mockApi.taskGroup.list.mockImplementation(
      async (_ws: string, opts?: { archived?: 'exclude' | 'only' | 'all' }) =>
        opts?.archived === 'only' ? [archivedGroup] : [],
    );
    // task.list 两态：archived:'only' → 归档任务；活跃拉取（5s 轮询/mount）→ 活跃任务
    mockApi.task.list.mockImplementation(
      async (opts?: { archived?: string }) =>
        opts?.archived === 'only' ? archivedTasks : [activeTask],
    );
    useTaskStore.setState({ tasks: [activeTask], currentWorkspaceId: 'ws-1' });
    useGroupStore.setState({ currentWorkspaceId: 'ws-1', selectedArchivedGroupId: 'g-z1' });
  }

  it('选中归档组 → BoardCanvas 不渲染、ArchivedBoardSection 出现（精确参数双拉取）', async () => {
    setupArchivedView();
    render(<TaskBoardView workspaceId="ws-1" />);

    // 归档泳道出现：组名 heading + 「已归档 · 只读」标识
    expect(await screen.findByRole('heading', { name: /归档组一/ })).toBeInTheDocument();
    expect(screen.getByText('已归档 · 只读')).toBeInTheDocument();
    // 两个拉取按 ArchivePanel 同款精确参数发起
    expect(mockApi.task.list).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      archived: 'only',
      orderBy: 'created_at_desc',
      limit: 500,
    });
    expect(mockApi.taskGroup.list).toHaveBeenCalledWith('ws-1', { archived: 'only' });
    // BoardCanvas 不渲染：活跃任务（task.store.tasks）不出现在归档视图
    expect(screen.queryByText(/活跃任务九/)).not.toBeInTheDocument();
    // 归档任务按状态进对列
    expect(screen.getByText(/归档任务甲/)).toBeInTheDocument();
    expect(screen.getByText(/归档任务乙/)).toBeInTheDocument();
  });

  it('归档视图下搜索框输入过滤归档行（工具栏过滤对归档行同样生效）', async () => {
    setupArchivedView();
    render(<TaskBoardView workspaceId="ws-1" />);
    await screen.findByRole('heading', { name: /归档组一/ });

    fireEvent.change(screen.getByRole('textbox', { name: '搜索任务' }), {
      target: { value: '甲' },
    });
    expect(screen.getByText(/归档任务甲/)).toBeInTheDocument();
    expect(screen.queryByText(/归档任务乙/)).not.toBeInTheDocument();
  });

  it('进入归档视图 → selectedTaskId 清空（旧详情抽屉不叠加）；退出 → 恢复正常看板', async () => {
    setupArchivedView();
    useTaskStore.setState({ selectedTaskId: 't9' });
    render(<TaskBoardView workspaceId="ws-1" />);

    // 进入即清：可编辑抽屉不叠加在只读视图上
    await screen.findByRole('heading', { name: /归档组一/ });
    expect(useTaskStore.getState().selectedTaskId).toBeNull();
    expect(screen.queryByRole('button', { name: '关闭' })).not.toBeInTheDocument();

    // 退出（侧边栏 toggle 写 null）→ 活跃画板恢复（活跃任务可见、归档泳道消失）
    act(() => {
      useGroupStore.getState().setSelectedArchivedGroupId(null);
    });
    expect(await screen.findByText(/活跃任务九/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /归档组一/ })).not.toBeInTheDocument();
    expect(screen.queryByText('已归档 · 只读')).not.toBeInTheDocument();
  });

  it('归档任务拉取失败 → 静默空态提示（不炸、不回退活跃画板）', async () => {
    setupArchivedView();
    mockApi.task.list.mockImplementation(async (opts?: { archived?: string }) => {
      if (opts?.archived === 'only') throw new Error('IPC 异常');
      return [];
    });
    render(<TaskBoardView workspaceId="ws-1" />);

    expect(await screen.findByText(/无法加载该归档分组/)).toBeInTheDocument();
    expect(useTaskStore.getState().selectedTaskId).toBeNull();
  });

  it('selectedArchivedGroupId 指向的组不在归档组列表 → 无效选中空态（不炸）', async () => {
    setupArchivedView();
    // 归档组列表返回空（组已被解档等）：选中悬空
    mockApi.taskGroup.list.mockImplementation(
      async (_ws: string, opts?: { archived?: 'exclude' | 'only' | 'all' }) =>
        opts?.archived === 'only' ? [] : [],
    );
    render(<TaskBoardView workspaceId="ws-1" />);

    expect(await screen.findByText(/无法加载该归档分组/)).toBeInTheDocument();
  });
});
