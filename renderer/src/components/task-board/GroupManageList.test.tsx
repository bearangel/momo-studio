// renderer/src/components/task-board/GroupManageList.test.tsx
//
// 分组管理列表测试（看板重构 Task 14；UX 波 2 #2/#3/#4/#5）：
//   - 渲染：position 升序、色点/组名/任务数（任务数从 task.store.tasks 实时按 groupId 计）
//   - 新建组：内联输入回车调 taskGroup.create（契约锁 {workspaceId, name}）
//   - 重命名：菜单触发行内编辑，回车调 taskGroup.update(id, {name})
//   - 换色：色板固定 5 语义色 + 应用内取色器（react-colorful；onChange 只更本地
//     预览零 IPC，「应用」唯一提交并关菜单；原生 input type=color 路径已移除）
//   - 菜单点外关闭：全屏遮罩点击关闭；再点触发按钮本身仍切换（UX 波 2 #4）
//   - 归档组：确认文案含实时未完结数 N；确认后 taskGroup.archive + task.list 级联刷新
//   - 取消归档：折叠区列归档组，点选调 taskGroup.unarchive + task.list 级联刷新
//   - 行满宽可点（UX 波 2 #3）：选择按钮 w-full；手柄/菜单点击不触发选中（结构隔离）
//   - 拖动调序（UX 波 2 #2，替代上下移按钮）：dnd DOM 拖拽 jsdom 测不了——
//     单测打在导出的纯函数 computeGroupOrder（照 Task 12 resolveDrop 模式）与
//     编排函数 applyGroupReorder（reorder 调用契约 + 失败 toast 错误路径）
//
// mock 边界：仅 mock window.api 与 react-colorful；group.store / task.store 真实实现。
//
// react-colorful mock 头注：jsdom 不渲染指针交互（PointerEvent / 布局量均缺），
// HexColorPicker 在单测中 mock 掉——保真其受控契约：接收 color、经 onChange(hex)
// 上报新值。mock 暴露一个原生 input 驱动 onChange（fireEvent.change），等价真实
// 交互「拖动选色 → 连发回调」；指针交互本身不在单测覆盖面（视觉验收走真机）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { GroupManageList, computeGroupOrder, applyGroupReorder } from './GroupManageList';
import { useTaskStore } from '../../stores/task.store';
import { useGroupStore } from '../../stores/group.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { GroupRow, TaskRow, Workspace } from '../../ipc/types';
import { Toast, dismissToast } from '../ui/Toast';

vi.mock('react-colorful', () => ({
  HexColorPicker: ({
    color,
    onChange,
  }: {
    color: string;
    onChange: (hex: string) => void;
  }) => (
    <div data-testid="hex-color-picker" data-color={color}>
      <input aria-label="模拟取色器选色" onChange={(e) => onChange(e.target.value)} />
    </div>
  ),
}));

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
const G_C = mkGroup({ id: 'g-c', name: '组C', position: 3072 });
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

  it('换色：应用内取色器渲染，初始值 = 当前组色映射 hex（语义名→亮色值），hex 文本同步', async () => {
    render(<GroupManageList />);
    await screen.findByLabelText('分组 组A');

    openMenu('组A');
    fireEvent.click(screen.getByRole('button', { name: '换色' }));
    // 组A color='accent' → #5e6ad2（globals.css accent-500 亮色值，映射纯函数
    // groupColorHex 的分支细节见 board.test.ts）
    expect(screen.getByTestId('hex-color-picker')).toHaveAttribute('data-color', '#5e6ad2');
    expect(screen.getByText('#5e6ad2')).toBeInTheDocument();
  });

  it('换色：取色器 onChange 只更本地预览（hex 文本实时跟随、大写规整小写、零 IPC、菜单不关）', async () => {
    render(<GroupManageList />);
    await screen.findByLabelText('分组 组A');

    openMenu('组A');
    fireEvent.click(screen.getByRole('button', { name: '换色' }));
    const pickerInput = screen.getByLabelText('模拟取色器选色');

    // 拖动中间态连发 onChange → 预览 hex 实时跟随（受控联动），零 IPC，菜单不关
    fireEvent.change(pickerInput, { target: { value: '#00ff00' } });
    expect(await screen.findByText('#00ff00')).toBeInTheDocument();
    fireEvent.change(pickerInput, { target: { value: '#AB34CD' } });
    expect(await screen.findByText('#ab34cd')).toBeInTheDocument();
    expect(screen.queryByText('#00ff00')).not.toBeInTheDocument();
    expect(screen.getByTestId('hex-color-picker')).toHaveAttribute('data-color', '#ab34cd');
    expect(mockApi.taskGroup.update).not.toHaveBeenCalled();
    expect(screen.getByTestId('group-menu-overlay')).toBeInTheDocument();
  });

  it('换色：「应用」以预览 hex 调 taskGroup.update 并关菜单（唯一提交路径）', async () => {
    render(<GroupManageList />);
    await screen.findByLabelText('分组 组A');

    openMenu('组A');
    fireEvent.click(screen.getByRole('button', { name: '换色' }));
    fireEvent.change(screen.getByLabelText('模拟取色器选色'), {
      target: { value: '#00cc00' },
    });
    expect(await screen.findByText('#00cc00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '应用' }));

    await waitFor(() => {
      expect(mockApi.taskGroup.update).toHaveBeenCalledTimes(1);
      expect(mockApi.taskGroup.update).toHaveBeenCalledWith('g-a', { color: '#00cc00' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('group-menu-overlay')).not.toBeInTheDocument();
    });
  });

  it('单开纪律：A 组菜单开着再点 B 组菜单——A 卸载只剩 B（修复叠加残留/穿透错乱）', async () => {
    render(<GroupManageList />);
    await screen.findByLabelText('分组 组A');

    openMenu('组A');
    expect(screen.getByRole('button', { name: '重命名' })).toBeInTheDocument();

    openMenu('组B');
    // 修复前：两份遮罩 + 两份菜单叠放。现：至多一遮罩一菜单
    expect(screen.getAllByTestId('group-menu-overlay')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '重命名' })).toHaveLength(1);

    // 留下的确实是 B 的菜单（重命名委托进 B 的行内编辑）
    fireEvent.click(screen.getByRole('button', { name: '重命名' }));
    expect(screen.getByLabelText('重命名组B')).toBeInTheDocument();
    expect(screen.queryByLabelText('重命名组A')).not.toBeInTheDocument();
  });

  it('菜单点外关闭：遮罩点击关闭菜单（UX 波 2 #4）；再点触发按钮本身仍切换', async () => {
    render(<GroupManageList />);
    await screen.findByLabelText('分组 组A');

    openMenu('组A');
    expect(screen.getByRole('button', { name: '重命名' })).toBeInTheDocument();
    expect(screen.getByTestId('group-menu-overlay')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('group-menu-overlay'));
    expect(screen.queryByRole('button', { name: '重命名' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('group-menu-overlay')).not.toBeInTheDocument();

    // 再点按钮本身 → 重新打开（触发器 z 序在遮罩上，仍可切换）
    openMenu('组A');
    expect(screen.getByRole('button', { name: '重命名' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('分组菜单 组A'));
    expect(screen.queryByRole('button', { name: '重命名' })).not.toBeInTheDocument();
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

  it('取消归档：折叠区列出归档组，点选调 taskGroup.unarchive + task.list 级联刷新', async () => {
    render(<GroupManageList />);
    await screen.findByLabelText('分组 组A');

    // 折叠区默认收起：展开后见归档组 + 取消归档按钮
    fireEvent.click(screen.getByLabelText('已归档分组'));
    expect(await screen.findByText('已归档组Z')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消归档 已归档组Z' }));

    await waitFor(() => {
      expect(mockApi.taskGroup.unarchive).toHaveBeenCalledWith('g-z');
    });
    // 解档连带恢复组内任务（主进程事务）→ 任务列表级联刷新（照归档组承接模式）
    await waitFor(() => {
      expect(mockApi.task.list).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'ws-1' }),
      );
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

    it('点击组行 → selectedGroupId 置位；再点同组 → 取消回 null', async () => {
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

    it('拖动手柄点击不触发选中也不调 reorder（结构隔离 + 点击≠拖动）：selectedGroupId 不动', async () => {
      render(<GroupManageList />);
      await screen.findByLabelText('分组 组A');

      fireEvent.click(screen.getByLabelText('拖动排序 组B'));
      expect(useGroupStore.getState().selectedGroupId).toBeNull();
      expect(mockApi.taskGroup.reorder).not.toHaveBeenCalled();

      // 先选中再点手柄：选中态不被手柄点击清掉/改变
      fireEvent.click(screen.getByLabelText('筛选分组 组A'));
      fireEvent.click(screen.getByLabelText('拖动排序 组B'));
      expect(useGroupStore.getState().selectedGroupId).toBe('g-a');
    });

    it('分组菜单触发不触发选中', async () => {
      render(<GroupManageList />);
      await screen.findByLabelText('分组 组A');

      fireEvent.click(screen.getByLabelText('分组菜单 组A'));
      expect(useGroupStore.getState().selectedGroupId).toBeNull();
    });
  });
});

describe('computeGroupOrder（UX 波 2 #2：拖动落点 → 新组序纯函数）', () => {
  it('下移：active 落到 over 位次（g-a 拖到 g-b 上 → 新序 [g-b, g-a]）', () => {
    expect(computeGroupOrder([G_A, G_B], 'g-a', 'g-b')).toEqual(['g-b', 'g-a']);
  });

  it('上移：g-b 拖到 g-a 上 → 新序 [g-b, g-a]', () => {
    expect(computeGroupOrder([G_A, G_B], 'g-b', 'g-a')).toEqual(['g-b', 'g-a']);
  });

  it('跨多位移动：三组中 g-a 拖到 g-c 上 → 新序 [g-b, g-c, g-a]', () => {
    expect(computeGroupOrder([G_A, G_B, G_C], 'g-a', 'g-c')).toEqual(['g-b', 'g-c', 'g-a']);
  });

  it('同位（active===over）→ null（不调 reorder）', () => {
    expect(computeGroupOrder([G_A, G_B], 'g-a', 'g-a')).toBeNull();
  });

  it('active 或 over 不在列表 → null', () => {
    expect(computeGroupOrder([G_A, G_B], 'g-x', 'g-a')).toBeNull();
    expect(computeGroupOrder([G_A, G_B], 'g-a', 'g-x')).toBeNull();
    expect(computeGroupOrder([], 'g-a', 'g-b')).toBeNull();
  });

  it('不修改输入数组（纯函数）', () => {
    const input = [G_A, G_B, G_C];
    const snapshot = [...input];
    computeGroupOrder(input, 'g-a', 'g-c');
    expect(input).toEqual(snapshot);
  });
});

describe('applyGroupReorder（拖动落点编排：reorder 调用契约）', () => {
  it('有效落点 → 以 computeGroupOrder 新序调 reorder', async () => {
    const reorder = vi.fn().mockResolvedValue(undefined);
    await applyGroupReorder([G_A, G_B], 'g-b', 'g-a', reorder);
    expect(reorder).toHaveBeenCalledWith(['g-b', 'g-a']);
  });

  it('同位 / 未知 id → 零调用', async () => {
    const reorder = vi.fn().mockResolvedValue(undefined);
    await applyGroupReorder([G_A, G_B], 'g-a', 'g-a', reorder);
    await applyGroupReorder([G_A, G_B], 'g-x', 'g-a', reorder);
    expect(reorder).not.toHaveBeenCalled();
  });

  it('reorder 失败 → toast 提示（错误路径；store.reorder 失败 rethrow，本地 groups 不动）', async () => {
    mockApi.taskGroup.reorder.mockRejectedValue(new Error('网络断开'));
    render(
      <>
        <GroupManageList />
        <Toast />
      </>,
    );
    await screen.findByLabelText('分组 组A');

    // 真实 store.reorder（走 mockApi）：失败 rethrow 由编排函数承接为 toast
    await applyGroupReorder([G_A, G_B], 'g-b', 'g-a', useGroupStore.getState().reorder);

    expect(await screen.findByTestId('ui-toast')).toHaveTextContent('调整分组顺序失败: 网络断开');
    // store.reorder 失败本地不动：仍为原序
    expect(useGroupStore.getState().groups.map((g) => g.id)).toEqual(['g-a', 'g-b']);
  });
});
