// renderer/src/components/task-board/EditTaskDialog.test.tsx
//
// K5 回归锁：任务编辑对话框——此前任务创建后无任何编辑入口。
//   - 打开时按现有 TaskRow 预填（标题/优先级/委派目标/循环规则反解析）
//   - 提交走 task.store.update（经真实 store → ipc.task.update），互斥三列
//     按目标类型只写一列
//   - 目标类型选了但未选对象 → 保存禁用
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EditTaskDialog } from './EditTaskDialog';
import type { TaskRow } from '../../ipc/types';
import { useTaskStore } from '../../stores/task.store';

const mockApi = {
  task: {
    update: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  },
  agent: {
    listMembers: vi.fn().mockResolvedValue([
      { instanceId: 'inst-1', agentName: 'coder' },
      { instanceId: 'inst-2', agentName: 'pm-agent' },
    ]),
  },
  team: {
    list: vi.fn().mockResolvedValue([{ id: 'team-1', name: '研发一组' }]),
  },
  session: {
    list: vi.fn().mockResolvedValue([{ id: 'sess-1', title: '架构评审' }]),
  },
};

function makeTask(overrides: Partial<TaskRow>): TaskRow {
  return {
    id: 'T-001',
    workspaceId: 'ws-1',
    title: '原始标题',
    description: '原始描述',
    status: 'assigned',
    priority: 5,
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'owner',
    executionSessionId: null,
    assigneeAgentId: 'inst-1',
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
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  mockApi.task.update.mockClear().mockResolvedValue(undefined);
  useTaskStore.setState({ tasks: [] });
});

function renderDialog(task: TaskRow, onSaved = vi.fn()): void {
  render(
    <EditTaskDialog
      open
      onClose={() => {}}
      onSaved={onSaved}
      task={task}
      workspaceId="ws-1"
    />,
  );
}

describe('EditTaskDialog 预填', () => {
  it('打开时预填标题/描述/优先级/指派', async () => {
    renderDialog(makeTask({}));
    const titleInput = (await screen.findByDisplayValue('原始标题')) as HTMLInputElement;
    expect(titleInput).toBeInTheDocument();
    expect(screen.getByDisplayValue('原始描述')).toBeInTheDocument();
    expect(screen.getByDisplayValue('coder')).toBeInTheDocument(); // 指派下拉选中 inst-1
    expect(screen.getByText('编辑任务 #T-001')).toBeInTheDocument();
  });

  it('循环任务 recurrenceRule 反解析预填（daily@09:00 → 每天）', async () => {
    renderDialog(makeTask({ recurrenceRule: 'daily@09:00' }));
    await screen.findByText('编辑任务 #T-001');
    const recSelect = screen.getByLabelText('循环规则') as HTMLSelectElement;
    expect(recSelect.value).toBe('daily');
    const timeInput = screen.getByLabelText('运行时间') as HTMLInputElement;
    expect(timeInput.value).toBe('09:00');
  });

  it('团队目标预填 targetKind=team', async () => {
    renderDialog(
      makeTask({ assigneeAgentId: null, targetTeamId: 'team-1' }),
    );
    const kindSelect = await screen.findByLabelText('委派目标类型');
    expect((kindSelect as HTMLSelectElement).value).toBe('team');
    await waitFor(() => {
      expect((screen.getByLabelText('委派目标') as HTMLSelectElement).value).toBe('team-1');
    });
  });
});

describe('EditTaskDialog 提交', () => {
  it('修改标题+优先级 → task.update 收到对应 patch（三互斥列按类型清空）', async () => {
    const onSaved = vi.fn();
    renderDialog(makeTask({}), onSaved);

    const titleInput = (await screen.findByDisplayValue('原始标题')) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: '新标题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockApi.task.update).toHaveBeenCalled());
    const [id, patch] = mockApi.task.update.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe('T-001');
    expect(patch.title).toBe('新标题');
    expect(patch.priority).toBe(5);
    expect(patch.assigneeAgentId).toBe('inst-1');
    expect(patch.targetTeamId).toBeNull();
    expect(patch.targetSessionId).toBeNull();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('切换目标类型到团队并选择 → update 写 targetTeamId、清 assignee', async () => {
    renderDialog(makeTask({}));

    const kindSelect = (await screen.findByLabelText(
      '委派目标类型',
    )) as HTMLSelectElement;
    fireEvent.change(kindSelect, { target: { value: 'team' } });
    const teamSelect = (await screen.findByLabelText('委派目标')) as HTMLSelectElement;
    await waitFor(() => {
      expect(teamSelect.options.length).toBeGreaterThan(1);
    });
    fireEvent.change(teamSelect, { target: { value: 'team-1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockApi.task.update).toHaveBeenCalled());
    const [, patch] = mockApi.task.update.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(patch.targetTeamId).toBe('team-1');
    expect(patch.assigneeAgentId).toBeNull();
  });

  it('目标类型选 team 但未选对象 → 保存按钮禁用', async () => {
    renderDialog(makeTask({}));
    const kindSelect = (await screen.findByLabelText(
      '委派目标类型',
    )) as HTMLSelectElement;
    fireEvent.change(kindSelect, { target: { value: 'team' } });
    const saveBtn = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('update 失败 → 显示错误信息且不关闭回调', async () => {
    const onSaved = vi.fn();
    mockApi.task.update.mockRejectedValue(new Error('任务不存在'));
    renderDialog(makeTask({}), onSaved);

    await screen.findByDisplayValue('原始标题');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/任务不存在/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
