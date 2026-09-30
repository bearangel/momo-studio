// renderer/src/components/task-board/AssignTargetDialog.test.tsx
//
// 指派并放入队列弹框（泳道语义重构 §4.4）：无目标 draft 拖入排队中时补齐
// 委派目标(+可选计划时间)后入队。行为锁：
//   1. 未选目标 → 「放入队列」禁用（沿 CreateTaskDialog 团队目标先例）
//   2. 选 agent + 提交 → update 互斥三列（agent 写入、team/session 清空）→
//      move(assigned, groupId)
//   3. 填未来计划时间 → update 携带 scheduledAt（move 目标不变，由闸门管）
//   4. 计划时间预填 task.scheduledAt 已有值；min=当前时间（防填过去）
//   5. update 成功 move 失败 → toast + 关闭（目标已写可重试，卡片留待办）
//   6. 取消 → 零 IPC 调用（pendingConfirm 同款零副作用语义）
//
// Mock 边界对齐 CreateTaskDialog.test：仅 mock ../../ipc/client，表单交互全真实。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AssignTargetDialog } from './AssignTargetDialog';
import { Toast, dismissToast } from '../ui/Toast';
import type { TaskRow } from '../../ipc/types';

// vi.hoisted：mock fn 在 vi.mock 工厂（会被提升到文件顶部）执行时已存在
const mockApi = vi.hoisted(() => ({
  task: {
    get: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    move: vi.fn().mockResolvedValue(null),
  },
  agent: {
    listMembers: vi.fn().mockResolvedValue([{ instanceId: 'inst-1', agentName: 'Sisyphus' }]),
  },
  team: {
    list: vi.fn().mockResolvedValue([{ id: 'team-1', name: '项目研发组' }]),
  },
  session: {
    list: vi.fn().mockResolvedValue([{ id: 'sess-1', title: '执行会话' }]),
  },
}));

vi.mock('../../ipc/client', () => ({ ipc: mockApi }));

function mkTask(overrides: Partial<TaskRow>): TaskRow {
  return {
    id: 'T-001',
    workspaceId: 'ws1',
    title: '无目标草稿',
    description: '',
    status: 'draft',
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'owner',
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
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    groupId: null,
    pinnedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function renderDialog(
  task: TaskRow = mkTask({}),
  groupId: string | null = null,
  onCancel: () => void = () => {},
): void {
  render(
    <>
      <Toast />
      <AssignTargetDialog open taskId={task.id} groupId={groupId} workspaceId="ws1" onCancel={onCancel} />
    </>,
  );
}

describe('AssignTargetDialog 指派并放入队列', () => {
  beforeEach(() => {
    mockApi.task.get.mockReset().mockResolvedValue(mkTask({}));
    mockApi.task.update.mockReset().mockResolvedValue(undefined);
    mockApi.task.move.mockReset().mockResolvedValue(null);
    mockApi.agent.listMembers.mockClear().mockResolvedValue([{ instanceId: 'inst-1', agentName: 'Sisyphus' }]);
    mockApi.team.list.mockClear().mockResolvedValue([{ id: 'team-1', name: '项目研发组' }]);
    mockApi.session.list.mockClear().mockResolvedValue([{ id: 'sess-1', title: '执行会话' }]);
    dismissToast();
  });

  it('open=false 不渲染', () => {
    const { container } = render(
      <AssignTargetDialog open={false} taskId="T-001" groupId={null} workspaceId="ws1" onCancel={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('未选目标 → 「放入队列」禁用', async () => {
    renderDialog();
    await screen.findByText('指派并放入队列');
    expect((screen.getByLabelText('委派目标') as HTMLSelectElement).value).toBe('');
    expect(screen.getByRole('button', { name: '放入队列' })).toBeDisabled();
  });

  it('选 agent + 提交 → update 互斥三列后 move(assigned, groupId)', async () => {
    renderDialog(mkTask({}), 'G-003');
    fireEvent.change(await screen.findByLabelText('委派目标'), { target: { value: 'inst-1' } });
    fireEvent.click(screen.getByRole('button', { name: '放入队列' }));
    await waitFor(() => expect(mockApi.task.move).toHaveBeenCalled());
    expect(mockApi.task.update).toHaveBeenCalledWith('T-001', {
      assigneeAgentId: 'inst-1',
      targetTeamId: null,
      targetSessionId: null,
      scheduledAt: null,
    });
    expect(mockApi.task.move).toHaveBeenCalledWith('T-001', { column: 'assigned', groupId: 'G-003' });
  });

  it('切到团队并选择 → update 写 targetTeamId、清 assignee', async () => {
    renderDialog();
    fireEvent.change(await screen.findByLabelText('委派类型'), { target: { value: 'team' } });
    fireEvent.change(await screen.findByLabelText('委派目标'), { target: { value: 'team-1' } });
    fireEvent.click(screen.getByRole('button', { name: '放入队列' }));
    await waitFor(() => expect(mockApi.task.move).toHaveBeenCalled());
    expect(mockApi.task.update).toHaveBeenCalledWith('T-001', {
      assigneeAgentId: null,
      targetTeamId: 'team-1',
      targetSessionId: null,
      scheduledAt: null,
    });
  });

  it('填未来计划时间 → update 携带 scheduledAt（move 不变，闸门管）', async () => {
    renderDialog();
    const future = new Date(Date.now() + 3_600_000);
    const futureLocal = new Date(future.getTime() - future.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
    fireEvent.change(await screen.findByLabelText('委派目标'), { target: { value: 'inst-1' } });
    fireEvent.change(screen.getByLabelText(/计划时间/), { target: { value: futureLocal } });
    fireEvent.click(screen.getByRole('button', { name: '放入队列' }));
    await waitFor(() => expect(mockApi.task.move).toHaveBeenCalled());
    const patch = mockApi.task.update.mock.calls[0][1] as { scheduledAt: number | null };
    expect(patch.scheduledAt).not.toBeNull();
    expect(patch.scheduledAt).toBeGreaterThan(Date.now());
  });

  it('计划时间预填任务已有 scheduledAt；min=当前时间（防填过去）', async () => {
    const existing = Date.now() + 7_200_000;
    mockApi.task.get.mockResolvedValue(mkTask({ scheduledAt: existing }));
    renderDialog();
    const input = (await screen.findByLabelText(/计划时间/)) as HTMLInputElement;
    expect(input.value).not.toBe(''); // 预填已有计划时间
    expect(input.min).not.toBe('');
  });

  it('update 成功 move 失败 → toast 错误且关闭回调触发（目标已写可重试）', async () => {
    mockApi.task.move.mockRejectedValue(new Error('目标分组不存在'));
    const onCancel = vi.fn();
    renderDialog(mkTask({}), null, onCancel);
    fireEvent.change(await screen.findByLabelText('委派目标'), { target: { value: 'inst-1' } });
    fireEvent.click(screen.getByRole('button', { name: '放入队列' }));
    expect(await screen.findByTestId('ui-toast')).toHaveTextContent(/目标分组不存在/);
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it('取消 → 零 IPC（update/move 均未调）', async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(mockApi.task.update).not.toHaveBeenCalled();
    expect(mockApi.task.move).not.toHaveBeenCalled();
  });
});
