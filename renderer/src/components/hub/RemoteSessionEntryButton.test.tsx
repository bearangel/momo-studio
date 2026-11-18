// RemoteSessionEntryButton 测试（入口回归修复 + 终态可达性）。
// 背景：旧 RemoteSessionEntry 随只读抽屉退役后「跟踪会话 → 查看远端」成死路
// （2026-11-18 人工验收实录）；且 session summary 的 task 反查排除终态任务
// （session-ops SQL status NOT IN 终态），完成后的跟踪会话 taskId 投影为
// null——入口须挂 kind 门 + 点击时按 execution_session_id 反查。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { RemoteSessionEntryButton } from './RemoteSessionEntryButton';
import { useUiStore } from '../../stores/ui.store';
import type { SessionSummary, TaskRow } from '../../ipc/types';

vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

const openRemoteSession = vi.fn();
useUiStore.setState({ openRemoteSession });

const task: TaskRow = {
  id: 'T-7', workspaceId: 'ws1', title: '外派任务', description: '', status: 'in_progress',
  sourceSessionId: null, sourceMessageId: null, creatorUserId: 'owner', executionSessionId: null,
  assigneeAgentId: null, targetTeamId: null, targetSessionId: null, recurrenceParentId: null,
  priority: 0, scheduledAt: null, recurrenceRule: null, deadlineAt: null, queuePosition: null,
  runtimeInstanceId: null, estimatedTokens: null, actualTokens: null, toolCallsUsed: 0,
  errorMessage: null, sourceNodeId: null, createdAt: 0, updatedAt: 0, startedAt: null, completedAt: null,
  currentRunId: null, submittedAt: null, acceptedAt: null, delegationRole: 'out', autoAccept: false,
  groupId: null, pinnedAt: null, archivedAt: null,
  routing: { mode: 'node', groupId: 'g', targetNodeId: 'n1' },
  delegationId: 'dl-7', origin: 'user', parentTaskId: null,
};

function makeSession(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1', workspaceId: 'ws1', title: '#T-007 · → node-b', kind: 'task_execution',
    createdAt: 0, updatedAt: 0, lastMessageAt: null,
    delegationRole: 'out', taskId: 'T-7',
    ...over,
  } as SessionSummary;
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    task: { get: vi.fn().mockResolvedValue(task), list: vi.fn().mockResolvedValue([]) },
  };
});

describe('RemoteSessionEntryButton', () => {
  it('运行中跟踪会话（join 命中 taskId）→ 渲染；点击 → 取任务后 openRemoteSession', async () => {
    render(<RemoteSessionEntryButton session={makeSession()} />);
    fireEvent.click(screen.getByRole('button', { name: /进入远端会话/ }));
    await waitFor(() => expect(openRemoteSession).toHaveBeenCalledWith(task));
  });

  it('终态任务跟踪会话（taskId 投影 null）→ 仍渲染，点击按 execution_session_id 反查任务', async () => {
    (window as unknown as { api: { task: { get: unknown; list: unknown } } }).api.task.list = vi
      .fn()
      .mockResolvedValue([{ ...task, executionSessionId: 'sess-1', status: 'completed' }, { id: 'T-x', workspaceId: 'ws1', title: '别的', status: 'pending', executionSessionId: null }]);
    render(<RemoteSessionEntryButton session={makeSession({ taskId: null, delegationRole: null })} />);
    fireEvent.click(screen.getByRole('button', { name: /进入远端会话/ }));
    await waitFor(() => expect(openRemoteSession).toHaveBeenCalled());
    const passed = openRemoteSession.mock.calls[0]![0] as TaskRow;
    expect(passed.id).toBe('T-7');
    expect(passed.delegationId).toBe('dl-7');
  });

  it('普通会话（kind=chat）→ 不渲染', () => {
    render(<RemoteSessionEntryButton session={makeSession({ kind: 'chat', delegationRole: null, taskId: null })} />);
    expect(screen.queryByRole('button', { name: /进入远端会话/ })).not.toBeInTheDocument();
  });

  it('反查无匹配（孤儿跟踪会话）→ 人话 toast 不开视图', async () => {
    const { showToast } = await import('../ui/Toast');
    render(<RemoteSessionEntryButton session={makeSession({ taskId: null, delegationRole: null })} />);
    fireEvent.click(screen.getByRole('button', { name: /进入远端会话/ }));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(openRemoteSession).not.toHaveBeenCalled();
  });
});
