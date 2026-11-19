// RemoteSteerComposer 测试（spec 2026-11-17 §7.3）——store 直植 + ipc mock：
// 1. 门控：running/waiting_human 可用（发送钮「发送指令」）；submitted 待裁决禁用
//    （占位「等待你的裁决…」）；终态禁用 + 占位「任务已结束」
// 2. 发送流：Enter 提交 trim 文本 → store.sendSteer；空文本不发
// 3. 超长：>4000 码点计数转 error 色并禁发
// 4. 草稿（2026-11-19）：卸载重挂载/切会话/发送后三态——草稿存模块级仓不随组件销毁
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { RemoteSteerComposer } from './RemoteSteerComposer';
import { resetComposerDrafts } from '../im/composer-drafts';
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
    recurrenceChainRoot: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 模块级草稿仓跨用例存续（写穿语义）——每用例清空防串扰
  resetComposerDrafts();
  useRemoteSessionStore.setState({
    phase: 'ready', errorText: null, task: makeTask('in_progress'),
    target: { targetNodeId: 'n', workspaceName: 'w', groupId: 'g', runNo: 1, nodeName: '节点B', sessionId: 's' },
    wire2: true, frames: [], legacy: [], hasMore: false, loadingEarlier: false,
    live: true, hubOnline: true, liveError: null, pendingSteers: [],
    sendSteer,
  } as Partial<ReturnType<typeof useRemoteSessionStore.getState>>);
});

describe('门控', () => {
  it.each(['in_progress', 'waiting_human'] as const)('%s → 可输入；有文本可发送', (status) => {
    useRemoteSessionStore.setState({ task: makeTask(status) } as Partial<ReturnType<typeof useRemoteSessionStore.getState>>);
    render(<RemoteSteerComposer sessionId="s1" />);
    const input = screen.getByPlaceholderText(/补充指令/);
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: '指令' } });
    expect(screen.getByRole('button', { name: /发送指令/ })).not.toBeDisabled();
  });

  it('submitted（待裁决）→ 整个 composer 不渲染（决策由验收卡独占）', () => {
    useRemoteSessionStore.setState({ task: makeTask('submitted') } as Partial<ReturnType<typeof useRemoteSessionStore.getState>>);
    const { container } = render(<RemoteSteerComposer sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('执行方（delegationRole=in）→ 不渲染（本机无 steer 权）', () => {
    const task = { ...makeTask('in_progress'), delegationRole: 'in' as const };
    useRemoteSessionStore.setState({ task } as Partial<ReturnType<typeof useRemoteSessionStore.getState>>);
    const { container } = render(<RemoteSteerComposer sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('%s → 禁用 + 占位「任务已结束」', (status) => {
    useRemoteSessionStore.setState({ task: makeTask(status) } as Partial<ReturnType<typeof useRemoteSessionStore.getState>>);
    render(<RemoteSteerComposer sessionId="s1" />);
    expect(screen.getByPlaceholderText('任务已结束')).toBeDisabled();
    expect(screen.getByRole('button', { name: /发送指令/ })).toBeDisabled();
  });
});

describe('发送流', () => {
  it('Enter 提交 trim 文本 → sendSteer；空文本不发', () => {
    render(<RemoteSteerComposer sessionId="s1" />);
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
    render(<RemoteSteerComposer sessionId="s1" />);
    const input = screen.getByPlaceholderText(/补充指令/) as HTMLTextAreaElement;
    const long = '😀'.repeat(4001); // 2 UTF-16 单元/码点
    fireEvent.change(input, { target: { value: long } });
    expect(screen.getByText(/4001\/4000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /发送指令/ })).toBeDisabled();
  });
});

// 2026-11-19 用户反馈同源 bug：切面板（MiddlePanel 条件渲染）卸载 steer
// composer → useState 文本丢失。锁：草稿随 sessionId 存模块仓，卸载重挂载、
// 切会话（prop 变化）、发送后三态语义正确。
describe('草稿（视图切换卸载不丢）', () => {
  it('卸载重挂载：未发送文本原样恢复', () => {
    const { unmount } = render(<RemoteSteerComposer sessionId="s1" />);
    fireEvent.change(screen.getByPlaceholderText(/补充指令/), { target: { value: '查完资料再发' } });
    unmount();

    render(<RemoteSteerComposer sessionId="s1" />);
    expect(screen.getByPlaceholderText(/补充指令/)).toHaveValue('查完资料再发');
  });

  it('不同会话草稿互不串扰', () => {
    const { unmount } = render(<RemoteSteerComposer sessionId="s1" />);
    fireEvent.change(screen.getByPlaceholderText(/补充指令/), { target: { value: 's1 的草稿' } });
    unmount();

    render(<RemoteSteerComposer sessionId="s2" />);
    expect(screen.getByPlaceholderText(/补充指令/)).toHaveValue('');
  });

  it('切会话（prop 变化不卸载）：草稿随会话切换、切回恢复', () => {
    const { rerender } = render(<RemoteSteerComposer sessionId="s1" />);
    fireEvent.change(screen.getByPlaceholderText(/补充指令/), { target: { value: 's1 的草稿' } });

    rerender(<RemoteSteerComposer sessionId="s2" />);
    expect(screen.getByPlaceholderText(/补充指令/)).toHaveValue('');

    rerender(<RemoteSteerComposer sessionId="s1" />);
    expect(screen.getByPlaceholderText(/补充指令/)).toHaveValue('s1 的草稿');
  });

  it('发送成功后卸载重挂载：不回潮已发送内容', async () => {
    const { unmount } = render(<RemoteSteerComposer sessionId="s1" />);
    const input = screen.getByPlaceholderText(/补充指令/);
    fireEvent.change(input, { target: { value: '指令' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    await waitFor(() => expect(sendSteer).toHaveBeenCalled());
    unmount();

    render(<RemoteSteerComposer sessionId="s1" />);
    expect(screen.getByPlaceholderText(/补充指令/)).toHaveValue('');
  });
});
