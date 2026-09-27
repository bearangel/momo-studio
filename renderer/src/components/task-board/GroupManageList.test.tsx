// renderer/src/components/task-board/GroupManageList.test.tsx
//
// 分组管理列表测试（看板重构 Task 14）：
//   - 渲染：position 升序、色点/组名/任务数（任务数从 task.store.tasks 实时按 groupId 计）
//   - 新建组：内联输入回车调 taskGroup.create（契约锁 {workspaceId, name}）
//   - 重命名：菜单触发行内编辑，回车调 taskGroup.update(id, {name})
//   - 换色：色板固定 5 语义色，点选调 taskGroup.update(id, {color})
//   - 归档组：确认文案含实时未完结数 N；确认后 taskGroup.archive + task.list 级联刷新
//   - 取消归档：折叠区列归档组，点选调 taskGroup.unarchive
//   - 调序（spec §5.1）：上/下移与相邻组交换后以新序调 taskGroup.reorder；
//     首组上移/末组下移 disabled；失败 toast（错误路径）
//
// mock 边界：仅 mock window.api；group.store / task.store 真实实现。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { GroupManageList } from './GroupManageList';
import { useTaskStore } from '../../stores/task.store';
import { useGroupStore } from '../../stores/group.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { GroupRow, TaskRow, Workspace } from '../../ipc/types';
import { Toast, dismissToast } from '../ui/Toast';

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

function mkTask(partial: Partial<TaskRow> & Pick<TaskRow, 'id' | 'status' | 'groupId'>): TaskRow {
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

const G_A = mkGroup({ id: 'g-a', name: '组A', position: 1024, color: 'accent' });
const G_B = mkGroup({ id: 'g-b', name: '组B', position: 2048 });
const G_ARCHIVED = mkGroup({ id: 'g-z', name: '已归档组Z', position: 4096, archivedAt: 12345 });

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
    create: vi.fn(),
    update: vi.fn(),
    reorder: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
  },
  task: {
    list: vi.fn().mockResolvedValue([]),
  },
};

/** 打开某组菜单（details/summary 菜单需先展开） */
function openMenu(groupName: string): void {
  fireEvent.click(screen.getByLabelText(`分组菜单 ${groupName}`));
}

describe('GroupManageList', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    // taskGroup.list 两态：默认活跃组；archived:'only' 只回归档组
    mockApi.taskGroup.list.mockReset().mockImplementation(
      async (_ws: string, opts?: { archived?: 'exclude' | 'only' | 'all' }) =>
        opts?.archived === 'only' ? [G_ARCHIVED] : [G_A, G_B],
    );
    mockApi.taskGroup.create.mockReset().mockImplementation(async (input: { name: string }) =>
      mkGroup({ id: 'g-new', name: input.name, position: 3072 }),
    );
    mockApi.taskGroup.update.mockReset().mockResolvedValue(G_A);
    mockApi.taskGroup.reorder.mockReset().mockResolvedValue(undefined);
    mockApi.taskGroup.archive.mockReset().mockResolvedValue({ cancelledIds: [], archivedCount: 2 });
    mockApi.taskGroup.unarchive.mockReset().mockResolvedValue(G_ARCHIVED);
    mockApi.task.list.mockClear().mockResolvedValue([]);
    useTaskStore.setState({ tasks: [], selectedTaskId: null, loading: false, error: null });
    useGroupStore.setState({
      groups: [],
      loading: false,
      error: null,
      currentWorkspaceId: null,
      selectedGroupId: null,
    });
    useWorkspaceStore.setState({ workspaces: [WS], activeWorkspaceId: WS.id, loading: false, error: null });
    dismissToast(); // toast 单例复位，防跨用例串扰
  });

  it('渲染组列表：position 升序 + 色点 + 组名 + 任务数（从 task.store 实时计）', async () => {
    useTaskStore.setState({
      tasks: [
        mkTask({ id: 't-1', status: 'in_progress', groupId: 'g-a' }),
        mkTask({ id: 't-2', status: 'completed', groupId: 'g-a' }),
        mkTask({ id: 't-3', status: 'draft', groupId: 'g-b' }),
      ],
      selectedTaskId: null,
      loading: false,
      error: null,
    });
    render(<GroupManageList />);

    // position 序：A(1024) 在 B(2048) 前
    const items = await screen.findAllByRole('listitem');
    expect(items.map((el) => el.getAttribute('aria-label'))).toEqual(['分组 组A', '分组 组B']);
    // 任务数：组A 2 条（组内活跃任务总数，非未完结数）/ 组B 1 条
    const [rowA, rowB] = items;
    if (!rowA || !rowB) throw new Error('应渲染两个分组行');
    expect(within(rowA).getByText('2')).toBeInTheDocument();
    expect(within(rowB).getByText('1')).toBeInTheDocument();
  });

  it('新建组：内联输入回车调 taskGroup.create（契约锁），成功后输入清空', async () => {
    render(<GroupManageList />);
    await screen.findByLabelText('分组 组A');

    fireEvent.click(screen.getByLabelText('新建组'));
    const input = screen.getByLabelText('新组名称');
    fireEvent.change(input, { target: { value: '新组' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockApi.taskGroup.create).toHaveBeenCalledWith({ workspaceId: 'ws-1', name: '新组' });
    });
    // 真实 store 语义：创建行进入 groups
    await waitFor(() => {
      expect(useGroupStore.getState().groups.some((g) => g.name === '新组')).toBe(true);
    });
  });

  it('重命名：菜单触发行内编辑，回车调 taskGroup.update(id, {name})', async () => {
    render(<GroupManageList />);
    await screen.findByLabelText('分组 组A');

    openMenu('组A');
    fireEvent.click(screen.getByRole('button', { name: '重命名' }));
    const input = screen.getByLabelText('重命名组A');
    fireEvent.change(input, { target: { value: '组A改' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockApi.taskGroup.update).toHaveBeenCalledWith('g-a', { name: '组A改' });
    });
  });

  it('换色：色板点选调 taskGroup.update(id, {color})，色板固定 5 语义色', async () => {
    render(<GroupManageList />);
    await screen.findByLabelText('分组 组A');

    openMenu('组A');
    fireEvent.click(screen.getByRole('button', { name: '换色' }));
    // 色板 5 色（与 lib/board GROUP_COLOR_VARS 同源词表）
    for (const label of ['accent', 'violet', 'success', 'warning', 'error']) {
      expect(screen.getByLabelText(`设为${label}`)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByLabelText('设为violet'));

    await waitFor(() => {
      expect(mockApi.taskGroup.update).toHaveBeenCalledWith('g-a', { color: 'violet' });
    });
  });

  it('归档组确认文案含实时未完结数 N（终态不计）；确认后 archive + task.list 级联刷新', async () => {
    useTaskStore.setState({
      tasks: [
        mkTask({ id: 't-1', status: 'in_progress', groupId: 'g-a' }),
        mkTask({ id: 't-2', status: 'assigned', groupId: 'g-a' }),
        mkTask({ id: 't-3', status: 'completed', groupId: 'g-a' }), // 终态不计
        mkTask({ id: 't-4', status: 'draft', groupId: 'g-b' }), // 他组不计
      ],
      selectedTaskId: null,
      loading: false,
      error: null,
    });
    render(<GroupManageList />);
    await screen.findByLabelText('分组 组A');

    openMenu('组A');
    fireEvent.click(screen.getByRole('button', { name: '归档组' }));

    // 确认文案：实时 N=2（非终态且在组内）
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText('组内还有 2 个未完结任务，将一并取消并归档'),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '归档' }));

    await waitFor(() => {
      expect(mockApi.taskGroup.archive).toHaveBeenCalledWith('g-a');
    });
    // Task 10 承接：归档成功后级联刷新任务列表
    await waitFor(() => {
      expect(mockApi.task.list).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'ws-1' }),
      );
    });
  });

  it('取消归档：折叠区列出归档组，点选调 taskGroup.unarchive', async () => {
    render(<GroupManageList />);
    await screen.findByLabelText('分组 组A');

    // 折叠区默认收起：展开后见归档组 + 取消归档按钮
    fireEvent.click(screen.getByLabelText('已归档分组'));
    expect(await screen.findByText('已归档组Z')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消归档 已归档组Z' }));

    await waitFor(() => {
      expect(mockApi.taskGroup.unarchive).toHaveBeenCalledWith('g-z');
    });
  });

  it('归档组中途取消：不调 archive', async () => {
    render(<GroupManageList />);
    await screen.findByLabelText('分组 组A');

    openMenu('组A');
    fireEvent.click(screen.getByRole('button', { name: '归档组' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(mockApi.taskGroup.archive).not.toHaveBeenCalled();
  });

  describe('分组点击过滤看板（UX 修复：selectedGroupId）', () => {
    it('「全部」行默认选中（aria-pressed），计数=活跃任务总数', async () => {
      useTaskStore.setState({
        tasks: [
          mkTask({ id: 't-1', status: 'draft', groupId: 'g-a' }),
          mkTask({ id: 't-2', status: 'draft', groupId: null }),
        ],
        selectedTaskId: null,
        loading: false,
        error: null,
      });
      render(<GroupManageList />);
      await screen.findByLabelText('分组 组A');

      expect(screen.getByLabelText('筛选全部分组')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByLabelText('筛选全部分组')).toHaveTextContent('2');
    });

    it('点击组行选择区 → selectedGroupId 置位；再点同组 → 取消回 null', async () => {
      render(<GroupManageList />);
      await screen.findByLabelText('分组 组A');

      fireEvent.click(screen.getByLabelText('筛选分组 组A'));
      expect(useGroupStore.getState().selectedGroupId).toBe('g-a');
      expect(screen.getByLabelText('筛选分组 组A')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByLabelText('筛选全部分组')).toHaveAttribute('aria-pressed', 'false');

      fireEvent.click(screen.getByLabelText('筛选分组 组A'));
      expect(useGroupStore.getState().selectedGroupId).toBeNull();
    });

    it('选中组后点「全部」→ selectedGroupId 清空', async () => {
      render(<GroupManageList />);
      await screen.findByLabelText('分组 组A');

      fireEvent.click(screen.getByLabelText('筛选分组 组B'));
      expect(useGroupStore.getState().selectedGroupId).toBe('g-b');
      fireEvent.click(screen.getByLabelText('筛选全部分组'));
      expect(useGroupStore.getState().selectedGroupId).toBeNull();
    });

    it('调序箭头点击不触发选中（兄弟布局结构隔离）：reorder 生效、selectedGroupId 不动', async () => {
      render(<GroupManageList />);
      await screen.findByLabelText('分组 组A');

      fireEvent.click(screen.getByRole('button', { name: '上移 组B' }));
      await waitFor(() => {
        expect(mockApi.taskGroup.reorder).toHaveBeenCalledWith(['g-b', 'g-a']);
      });
      expect(useGroupStore.getState().selectedGroupId).toBeNull();

      // 先选中再调序：选中态不被调序点击清掉/改变
      fireEvent.click(screen.getByLabelText('筛选分组 组A'));
      fireEvent.click(screen.getByRole('button', { name: '上移 组B' }));
      expect(useGroupStore.getState().selectedGroupId).toBe('g-a');
    });

    it('分组菜单触发不触发选中', async () => {
      render(<GroupManageList />);
      await screen.findByLabelText('分组 组A');

      fireEvent.click(screen.getByLabelText('分组菜单 组A'));
      expect(useGroupStore.getState().selectedGroupId).toBeNull();
    });
  });

  describe('分组调序（spec §5.1 可调序）', () => {
    it('上移组B → 与相邻组交换后以新序调 taskGroup.reorder（参数序正确）', async () => {
      render(<GroupManageList />);
      await screen.findByLabelText('分组 组A');

      fireEvent.click(screen.getByRole('button', { name: '上移 组B' }));

      await waitFor(() => {
        expect(mockApi.taskGroup.reorder).toHaveBeenCalledWith(['g-b', 'g-a']);
      });
    });

    it('下移组A → 新序 [g-b, g-a] 调 taskGroup.reorder', async () => {
      render(<GroupManageList />);
      await screen.findByLabelText('分组 组A');

      fireEvent.click(screen.getByRole('button', { name: '下移 组A' }));

      await waitFor(() => {
        expect(mockApi.taskGroup.reorder).toHaveBeenCalledWith(['g-b', 'g-a']);
      });
    });

    it('首组「上移」/ 末组「下移」disabled，点击不调 reorder', async () => {
      render(<GroupManageList />);
      await screen.findByLabelText('分组 组A');

      expect(screen.getByRole('button', { name: '上移 组A' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '下移 组B' })).toBeDisabled();
      expect(mockApi.taskGroup.reorder).not.toHaveBeenCalled();
    });

    it('reorder 失败（IPC reject）→ toast 提示，本地 groups 不动（错误路径）', async () => {
      mockApi.taskGroup.reorder.mockRejectedValue(new Error('网络断开'));
      render(
        <>
          <GroupManageList />
          <Toast />
        </>,
      );
      await screen.findByLabelText('分组 组A');

      fireEvent.click(screen.getByRole('button', { name: '上移 组B' }));

      expect(await screen.findByTestId('ui-toast')).toHaveTextContent('调整分组顺序失败: 网络断开');
      // store.reorder 失败本地不动：仍为原序
      expect(useGroupStore.getState().groups.map((g) => g.id)).toEqual(['g-a', 'g-b']);
    });
  });
});
