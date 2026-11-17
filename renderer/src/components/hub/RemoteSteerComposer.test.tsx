// RemoteSteerComposer 测试（spec 2026-11-17 §7.3）——store 直植 + ipc mock：
// 1. 门控：running/waiting_human/submitted 可用（发送钮「发送指令」）；终态禁用 +
//    占位「任务已结束」
// 2. 发送流：Enter 提交 trim 文本 → store.sendSteer；空文本不发
// 3. 超长：>4000 码点计数转 error 色并禁发
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { RemoteSteerComposer } from './RemoteSteerComposer';
import { useRemoteSessionStore } from '../../stores/remote-session.view';
import type { TaskRow } from '../../ipc/types';

const sendSteer = vi.fn().mockResolvedValue(undefined);

function makeTask(status: TaskRow['status']): TaskRow {
  return {
    id: 'T-7', workspaceId: 'ws1', title: 't', description: '', status,
    sourceSessionId: null, sourceMessageId: null, creatorUserId: 'owner', executionSessionId: null,
    assigneeAgentId: null, targetTeamId: null, targetSessionId: null, recurrenceParentId: null,
    priority: 0, scheduledAt: null, recurrenceRule: null, deadlineAt: null, queuePosition: null,
    runtimeInstanceId: null, estimatedTokens: null, actualTokens: null, toolCallsUsed: 0,
    errorMessage: null, sourceNodeId: null, createdAt: 0, updatedAt: 0, startedAt: null, completedAt: null,
    currentRunId: null, submittedAt: null, acceptedAt: null, delegationRole: 'out', autoAccept: false,
    groupId: null, pinnedAt: null, archivedAt: null,
    routing: { mode: 'node', groupId: 'g', targetNodeId: 'n' },
    delegationId: 'dl', origin: 'user', parentTaskId: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useRemoteSessionStore.setState({
    phase: 'ready', errorText: null, task: makeTask('in_progress'),
    target: { targetNodeId: 'n', workspaceName: 'w', groupId: 'g', runNo: 1, nodeName: '节点B', sessionId: 's' },
    wire2: true, frames: [], legacy: [], hasMore: false, loadingEarlier: false,
    live: true, hubOnline: true, liveError: null, pendingSteers: [],
    sendSteer,
  } as Partial<ReturnType<typeof useRemoteSessionStore.getState>>);
});

describe('门控', () => {
  it.each(['in_progress', 'waiting_human', 'submitted'] as const)('%s → 可输入；有文本可发送', (status) => {
    useRemoteSessionStore.setState({ task: makeTask(status) } as Partial<ReturnType<typeof useRemoteSessionStore.getState>>);
    render(<RemoteSteerComposer />);
    const input = screen.getByPlaceholderText(/补充指令/);
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: '指令' } });
    expect(screen.getByRole('button', { name: /发送指令/ })).not.toBeDisabled();
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('%s → 禁用 + 占位「任务已结束」', (status) => {
    useRemoteSessionStore.setState({ task: makeTask(status) } as Partial<ReturnType<typeof useRemoteSessionStore.getState>>);
    render(<RemoteSteerComposer />);
    expect(screen.getByPlaceholderText('任务已结束')).toBeDisabled();
    expect(screen.getByRole('button', { name: /发送指令/ })).toBeDisabled();
  });
});

describe('发送流', () => {
  it('Enter 提交 trim 文本 → sendSteer；空文本不发', () => {
    render(<RemoteSteerComposer />);
    const input = screen.getByPlaceholderText(/补充指令/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '  先写测试  ' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(sendSteer).toHaveBeenCalledWith('先写测试');
    sendSteer.mockClear();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(sendSteer).not.toHaveBeenCalled();
  });

  it('超 4000 码点 → 计数转 error 色并禁发（码点计非 UTF-16 单元）', () => {
    render(<RemoteSteerComposer />);
    const input = screen.getByPlaceholderText(/补充指令/) as HTMLTextAreaElement;
    const long = '😀'.repeat(4001); // 2 UTF-16 单元/码点
    fireEvent.change(input, { target: { value: long } });
    expect(screen.getByText(/4001\/4000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /发送指令/ })).toBeDisabled();
  });
});
