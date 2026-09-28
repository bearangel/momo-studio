// renderer/src/components/task-board/GroupMenu.test.tsx
//
// 分组菜单删除流程测试（删除分组 = 删容器不删内容）：
//   - 菜单「删除分组」项打开确认 Dialog：标题含组名、组内 N 个任务（全状态计）
//   - 转移目标 Select 默认「未分组」，候选 = 其他活跃组（排除自身）
//   - 默认直接确认 → taskGroup.delete(id, null)
//   - 选择目标组后确认 → taskGroup.delete(id, moveTo) + task.list 级联刷新
//   - 取消 → 零 IPC 调用
//   - 确认后 selectedGroupId 指向被删组 → 置 null（回「全部」）
//
// mock 边界：仅 mock window.api 与 react-colorful；group.store / task.store 真实实现
// （照 GroupManageList.test.tsx 先例——store 语义在链路里真实跑，不用手构中间态）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { GroupMenu } from './GroupMenu';
import { useTaskStore } from '../../stores/task.store';
import { useGroupStore } from '../../stores/group.store';
import { dismissToast } from '../ui/Toast';
import type { GroupRow, TaskRow } from '../../ipc/types';

vi.mock('react-colorful', () => ({
  HexColorPicker: () => <div data-testid="hex-color-picker" />,
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

const G_A = mkGroup({ id: 'g-a', name: '组A', position: 1024 });
const G_B = mkGroup({ id: 'g-b', name: '组B', position: 2048 });

const mockApi = {
  taskGroup: {
    list: vi.fn(),
    delete: vi.fn(),
  },
  task: {
    list: vi.fn(),
  },
};

/** 打开组A 菜单并点「删除分组」，返回确认 Dialog */
async function openDeleteDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByLabelText('分组菜单 组A'));
  fireEvent.click(screen.getByRole('button', { name: '删除分组' }));
  return await screen.findByRole('dialog');
}

describe('GroupMenu 删除分组', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    // delete 成功后的组列表重拉：只剩组B（权威值）
    mockApi.taskGroup.list.mockReset().mockResolvedValue([G_B]);
    mockApi.taskGroup.delete.mockReset().mockResolvedValue({ movedCount: 2 });
    mockApi.task.list.mockReset().mockResolvedValue([]);
    useTaskStore.setState({
      tasks: [
        mkTask({ id: 't-1', status: 'in_progress', groupId: 'g-a' }),
        mkTask({ id: 't-2', status: 'completed', groupId: 'g-a' }), // 删除时终态也转移，N 全状态计
        mkTask({ id: 't-3', status: 'draft', groupId: 'g-b' }), // 他组不计
      ],
      selectedTaskId: null,
      loading: false,
      error: null,
      currentWorkspaceId: 'ws-1',
      pendingMoveCount: 0,
      dragging: false,
    });
    useGroupStore.setState({
      groups: [G_A, G_B],
      loading: false,
      error: null,
      currentWorkspaceId: 'ws-1',
      selectedGroupId: null,
    });
    dismissToast();
  });

  it('菜单项打开确认 Dialog：标题含组名 + 组内 N（全状态计）+ Select 候选排除自身', async () => {
    render(<GroupMenu group={G_A} triggerLabel="分组菜单 组A" />);

    const dialog = await openDeleteDialog();

    expect(within(dialog).getByText('删除分组「组A」')).toBeInTheDocument();
    // N=2：组A 的 in_progress + completed 都转移（他组 t-3 不计）
    expect(within(dialog).getByText('组内 2 个任务将转移到:')).toBeInTheDocument();
    const select = within(dialog).getByLabelText('转移目标分组') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['未分组', '组B']);
  });

  it('默认未分组：直接确认以 moveToGroupId=null 调 delete', async () => {
    render(<GroupMenu group={G_A} triggerLabel="分组菜单 组A" />);
    const dialog = await openDeleteDialog();

    const select = within(dialog).getByLabelText('转移目标分组') as HTMLSelectElement;
    expect(select.value).toBe(''); // 默认「未分组」
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(mockApi.taskGroup.delete).toHaveBeenCalledWith('g-a', null);
    });
  });

  it('选择目标组后以 moveTo 调 delete + task.list 级联刷新 + Dialog 关闭', async () => {
    render(<GroupMenu group={G_A} triggerLabel="分组菜单 组A" />);
    const dialog = await openDeleteDialog();

    fireEvent.change(within(dialog).getByLabelText('转移目标分组'), { target: { value: 'g-b' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(mockApi.taskGroup.delete).toHaveBeenCalledWith('g-a', 'g-b');
    });
    // 转移改变任务归属 → 任务列表级联刷新（照归档承接模式）
    await waitFor(() => {
      expect(mockApi.task.list).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'ws-1' }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('取消零调用：点「取消」关 Dialog，不调 delete', async () => {
    render(<GroupMenu group={G_A} triggerLabel="分组菜单 组A" />);
    const dialog = await openDeleteDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(mockApi.taskGroup.delete).not.toHaveBeenCalled();
    expect(mockApi.task.list).not.toHaveBeenCalled();
  });

  it('确认后选中态回「全部」：selectedGroupId 指向被删组 → null', async () => {
    useGroupStore.setState({ selectedGroupId: 'g-a' });
    render(<GroupMenu group={G_A} triggerLabel="分组菜单 组A" />);
    const dialog = await openDeleteDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(useGroupStore.getState().selectedGroupId).toBeNull();
    });
    // 真实 store 语义：组列表重拉后只剩组B
    await waitFor(() => {
      expect(useGroupStore.getState().groups.map((g) => g.id)).toEqual(['g-b']);
    });
  });
});
