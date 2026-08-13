// renderer/src/components/im/MessageBubble.test.tsx
//
// MessageBubble 路由行为：按 eventType 分发到 DispatchCard/TaskReplyCard，
// 并正确透传 isSelf + senderName。用 vi.mock 把卡片替换为可控桩，隔离 store 依赖。
//
// v2.0 A 子系统重写：
//   - 按 message.id 查 stream.store，streaming 时渲染 AgentStreamBubble
//   - 删除旧版从 content 提取 io.momo-studio.* 富字段的测试（逻辑已移除）
//   - 新增 streaming/静态分支测试
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ImMessage } from '../../ipc/types';
import type { StreamState } from '../../stores/stream.store';

// 可控 mock streams（测试注入 streaming entry）
const mockStreams = new Map<string, StreamState>();

vi.mock('../../stores/stream.store', () => ({
  useStreamStore: (selector: (s: { streams: Map<string, StreamState> }) => unknown) =>
    selector({ streams: mockStreams }),
}));

vi.mock('./DispatchCard', () => ({
  DispatchCard: (props: { senderName?: string; isSelf: boolean }) => (
    <div data-testid="dispatch" data-self={String(props.isSelf)} data-name={props.senderName ?? ''} />
  ),
}));
vi.mock('./TaskReplyCard', () => ({
  TaskReplyCard: (props: { senderName?: string; isSelf: boolean }) => (
    <div data-testid="task-reply" data-self={String(props.isSelf)} data-name={props.senderName ?? ''} />
  ),
}));
vi.mock('./AgentStreamBubble', () => ({
  AgentStreamBubble: (props: { message: ImMessage; senderName?: string }) => (
    <div data-testid="agent-stream" data-msg-id={props.message.id} data-name={props.senderName ?? ''} />
  ),
}));

import { MessageBubble } from './MessageBubble';

function makeMsg(id: string, overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id,
    roomId: '!r',
    sender: '@bot:local',
    body: '',
    eventType: 'm.room.message',
    streamSessionId: null,
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'done',
    source: 'local',
    matrixEventId: null,
    workspaceId: null,
    taskId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeStream(overrides: Partial<StreamState> = {}): StreamState {
  return {
    thinking: '',
    text: '',
    toolCalls: [],
    todos: [],
    dispatches: [],
    status: 'streaming',
    events: [],
    messageId: 'm1',
    startedAt: Date.now(),
    ...overrides,
  };
}

describe('MessageBubble 路由', () => {
  it('io.momo-studio.dispatch → DispatchCard', () => {
    const msg = makeMsg('m1', { eventType: 'io.momo-studio.dispatch' });
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.getByTestId('dispatch')).toBeInTheDocument();
    expect(screen.queryByTestId('task-reply')).not.toBeInTheDocument();
  });

  it('dispatch 透传 isSelf + senderName', () => {
    const msg = makeMsg('m1', { eventType: 'io.momo-studio.dispatch' });
    render(<MessageBubble message={msg} isSelf={true} senderName="协调员" />);
    const card = screen.getByTestId('dispatch');
    expect(card).toHaveAttribute('data-self', 'true');
    expect(card).toHaveAttribute('data-name', '协调员');
  });

  it('io.momo-studio.task_reply → TaskReplyCard', () => {
    const msg = makeMsg('m1', { eventType: 'io.momo-studio.task_reply' });
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    expect(screen.getByTestId('task-reply')).toBeInTheDocument();
    expect(screen.queryByTestId('dispatch')).not.toBeInTheDocument();
  });

  it('task_reply 透传 isSelf + senderName', () => {
    const msg = makeMsg('m1', { eventType: 'io.momo-studio.task_reply' });
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    const card = screen.getByTestId('task-reply');
    expect(card).toHaveAttribute('data-self', 'false');
    expect(card).toHaveAttribute('data-name', '码农');
  });

  it('m.room.message 无 stream → 普通气泡（显示 body）', () => {
    mockStreams.clear();
    const msg = makeMsg('m1', { body: '你好' });
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    expect(screen.getByText('你好')).toBeInTheDocument();
    expect(screen.getByText('码农')).toBeInTheDocument();
    expect(screen.queryByTestId('dispatch')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-reply')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-stream')).not.toBeInTheDocument();
  });
});

describe('MessageBubble streaming 分支（A 子系统）', () => {
  it('stream.status=streaming → AgentStreamBubble', () => {
    mockStreams.clear();
    mockStreams.set('m1', makeStream({ messageId: 'm1', status: 'streaming' }));
    const msg = makeMsg('m1', { body: '流式中正文' });
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.getByTestId('agent-stream')).toBeInTheDocument();
    expect(screen.getByTestId('agent-stream')).toHaveAttribute('data-msg-id', 'm1');
    expect(screen.getByTestId('agent-stream')).toHaveAttribute('data-name', '协调员');
  });

  it('stream.status=done → 静态气泡（不渲染 AgentStreamBubble）', () => {
    mockStreams.clear();
    mockStreams.set('m1', makeStream({ messageId: 'm1', status: 'done' }));
    const msg = makeMsg('m1', { body: '已完成正文' });
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.queryByTestId('agent-stream')).not.toBeInTheDocument();
    expect(screen.getByText('已完成正文')).toBeInTheDocument();
  });

  it('stream.status=failed → 静态气泡（兜底显示 message.body）', () => {
    mockStreams.clear();
    mockStreams.set('m1', makeStream({ messageId: 'm1', status: 'failed' }));
    const msg = makeMsg('m1', { body: '失败前的正文' });
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.queryByTestId('agent-stream')).not.toBeInTheDocument();
    expect(screen.getByText('失败前的正文')).toBeInTheDocument();
  });
});
