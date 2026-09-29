// renderer/src/components/im/TurnUndoDialog.test.tsx
//
// 撤回联动取消测试（G3 spec §5）：
//   - task.list 预检（sourceMessageIds: turn.messageIds）
//   - 分层矩阵：未启动默认勾选 / 进行中无勾选框 / 终态灰显
//   - 确认序：journal.revert → session.deleteMessages → reload → task.cancel（勾选集）
//   - cancel 失败 → error phase 逐条呈现（对话已撤回事实保留）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ImMessage, TaskRow } from '../../ipc/types';
import { useSessionStore } from '../../stores/session.store';
import { TurnUndoDialog } from './TurnUndoDialog';

const taskListMock = vi.fn();
const taskCancelMock = vi.fn();
const journalListMock = vi.fn();
const journalPreviewMock = vi.fn();
const journalRevertMock = vi.fn();
const deleteMessagesMock = vi.fn();
const getMessagesMock = vi.fn();

const mockApi = {
  task: { list: taskListMock, cancel: taskCancelMock },
  journal: { list: journalListMock, preview: journalPreviewMock, revert: journalRevertMock },
  session: { deleteMessages: deleteMessagesMock, getMessages: getMessagesMock },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

function makeMsg(overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id: 'm-a', sessionId: 'ses-1', sender: 'owner', body: 'q', eventType: 'm.room.message',
    streamSessionId: null, parentStreamSessionId: null, segmentOf: null, segmentIndex: null,
    status: 'done', source: 'local', workspaceId: 'ws-1', taskId: null, contextJson: null,
    createdAt: 1, updatedAt: 1, ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-1', workspaceId: 'ws-1', title: '联动任务', description: '', status: 'draft',
    sourceSessionId: 'ses-1', sourceMessageId: 'm-a', creatorUserId: 'owner',
    executionSessionId: null, assigneeAgentId: null, targetTeamId: null, targetSessionId: null,
    recurrenceParentId: null, priority: 0, scheduledAt: null, recurrenceRule: null,
    deadlineAt: null, queuePosition: null, runtimeInstanceId: null, estimatedTokens: null,
    actualTokens: null, toolCallsUsed: 0, errorMessage: null, sourceNodeId: null,
    createdAt: 1, updatedAt: 1, startedAt: null, completedAt: null,
    groupId: null, boardPosition: null, archivedAt: null, ...overrides,
  };
}

/** 组装一轮对话：owner m-a + agent m-b（带 streamSessionId 供账本匹配） */
function seedTurn(): void {
  useSessionStore.setState({
    messagesBySession: new Map([
      ['ses-1', [makeMsg({ id: 'm-a' }), makeMsg({ id: 'm-b', sender: 'agent', streamSessionId: 's-1' })]],
    ]),
    reloadMessages: vi.fn().mockImplementation(async () => {}),
  } as never);
}

beforeEach(() => {
  taskListMock.mockReset().mockResolvedValue([]);
  taskCancelMock.mockReset().mockResolvedValue(undefined);
  journalListMock.mockReset().mockResolvedValue([]);
  journalPreviewMock.mockReset().mockResolvedValue([]);
  journalRevertMock.mockReset().mockResolvedValue([]);
  deleteMessagesMock.mockReset().mockResolvedValue({ deletedIds: [], affectedSessions: [] });
  getMessagesMock.mockReset().mockResolvedValue({ messages: [], eventsByMessage: {} });
  seedTurn();
});

describe('TurnUndoDialog — 关联任务预检与分层', () => {
  it('预检调 task.list({workspaceId, sourceMessageIds: 组内全部消息 id})', async () => {
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={() => {}} />);
    await screen.findByTestId('turn-undo-confirm');
    await waitFor(() =>
      expect(taskListMock).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        sourceMessageIds: ['m-a', 'm-b'],
      }),
    );
  });

  it('未启动任务（draft）默认勾选「撤回时一并取消」', async () => {
    taskListMock.mockResolvedValue([makeTask({ status: 'draft' })]);
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={() => {}} />);
    expect(await screen.findByTestId('turn-undo-linked-tasks')).toBeInTheDocument();
    expect(screen.getByTestId('turn-undo-cancel-task-1')).toBeChecked();
  });

  it('进行中任务无勾选框 + 明示「仍在执行，不会被自动取消」', async () => {
    taskListMock.mockResolvedValue([makeTask({ status: 'in_progress' })]);
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={() => {}} />);
    await screen.findByTestId('turn-undo-linked-tasks');
    expect(screen.queryByTestId('turn-undo-cancel-task-1')).not.toBeInTheDocument();
    expect(screen.getByText('仍在执行，不会被自动取消')).toBeInTheDocument();
  });

  it('终态任务灰显「已结束，不受影响」', async () => {
    taskListMock.mockResolvedValue([makeTask({ status: 'completed' })]);
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={() => {}} />);
    await screen.findByTestId('turn-undo-linked-tasks');
    expect(screen.queryByTestId('turn-undo-cancel-task-1')).not.toBeInTheDocument();
    expect(screen.getByText('已结束，不受影响')).toBeInTheDocument();
  });

  it('无关联任务 → 区块不渲染', async () => {
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={() => {}} />);
    await screen.findByTestId('turn-undo-confirm');
    expect(screen.queryByTestId('turn-undo-linked-tasks')).not.toBeInTheDocument();
  });
});

describe('TurnUndoDialog — 确认执行联动', () => {
  it('确认 → deleteMessages 成功后 cancel 勾选任务；取消勾选的不 cancel', async () => {
    taskListMock.mockResolvedValue([
      makeTask({ id: 'task-1', status: 'draft' }),
      makeTask({ id: 'task-2', status: 'assigned' }),
    ]);
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('turn-undo-confirm-btn'));
    await waitFor(() => expect(deleteMessagesMock).toHaveBeenCalledWith('ses-1', ['m-a', 'm-b']));
    // 默认勾选语义：两个未启动任务都被取消
    await waitFor(() => expect(taskCancelMock).toHaveBeenCalledWith('task-1'));
    await waitFor(() => expect(taskCancelMock).toHaveBeenCalledWith('task-2'));
    // 顺序锁：先撤后取消（spec §5.2——反向是「任务取消了但对话没撤掉」脏状态）
    const cancelOrder = taskCancelMock.mock.invocationCallOrder[0];
    const deleteOrder = deleteMessagesMock.mock.invocationCallOrder[0];
    // 前面的 waitFor 已保证各至少调用一次，这里只做窄化
    if (cancelOrder === undefined || deleteOrder === undefined) {
      throw new Error('invocationCallOrder 缺失：deleteMessages 或 task.cancel 未被调用');
    }
    expect(cancelOrder).toBeGreaterThan(deleteOrder);
  });

  it('取消勾选的任务不被 cancel', async () => {
    taskListMock.mockResolvedValue([makeTask({ status: 'draft' })]);
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('turn-undo-cancel-task-1'));
    fireEvent.click(await screen.findByTestId('turn-undo-confirm-btn'));
    await waitFor(() => expect(deleteMessagesMock).toHaveBeenCalled());
    expect(taskCancelMock).not.toHaveBeenCalled();
  });

  it('cancel 失败 → error phase 逐条呈现（对话已撤回事实保留）', async () => {
    taskListMock.mockResolvedValue([makeTask({ status: 'draft' })]);
    taskCancelMock.mockRejectedValue(new Error('状态机拒绝'));
    const onClose = vi.fn();
    render(<TurnUndoDialog workspaceId="ws-1" sessionId="ses-1" onClose={onClose} />);
    fireEvent.click(await screen.findByTestId('turn-undo-confirm-btn'));
    const err = await screen.findByTestId('turn-undo-error');
    expect(err).toHaveTextContent(/task-1/);
    expect(err).toHaveTextContent(/状态机拒绝/);
    expect(onClose).not.toHaveBeenCalled();
  });
});
