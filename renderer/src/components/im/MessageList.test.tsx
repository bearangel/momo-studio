// renderer/src/components/im/MessageList.test.tsx
//
// MessageList v1.4 过滤行为测试：dispatch / task_reply / 含 parent_stream_session_id
// 的 m.room.message 不应作为顶层独立消息渲染（已嵌套到 PM 气泡的 dispatch chip 内）。
// 用 vi.mock 把 MessageBubble 替换为暴露 eventType/body 的桩，store 用 selector 透传桩。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ImMessage } from '../../ipc/types';

// vi.hoisted 保证 store 状态在 vi.mock 工厂注册前完成初始化（工厂内只定义函数，
// 实际 state 访问延迟到 render 期，但 hoisted 可规避 TS「used before declaration」告警）。
const { imState, authState } = vi.hoisted(() => ({
  imState: {
    activeRoomId: '!room:server',
    messagesByRoom: new Map<string, ImMessage[]>(),
    loading: false,
    loadingOlderByRoom: new Map<string, boolean>(),
    hasMoreByRoom: new Map<string, boolean>(),
    teamRoomMessages: [],
    loadOlder: () => Promise.resolve(),
  },
  authState: { user: { userId: '@me:server' } },
}));

vi.mock('../../stores/im.store', () => ({
  useImStore: (selector: (s: typeof imState) => unknown) => selector(imState),
}));
vi.mock('../../stores/auth.store', () => ({
  useAuthStore: (selector: (s: typeof authState) => unknown) => selector(authState),
}));
vi.mock('../../stores/stream.store', () => ({
  useStreamStore: (selector: (s: { streams: Map<string, unknown> }) => unknown) =>
    selector({ streams: new Map() }),
}));
vi.mock('../../lib/useBotNames', () => ({
  useBotNameMap: () => new Map(),
}));

// 桩 MessageBubble：渲染 body + data-event-type/data-event-id，便于断言通过过滤的消息
vi.mock('./MessageBubble', () => ({
  MessageBubble: ({ message }: { message: ImMessage }) => (
    <div
      data-testid="bubble"
      data-event-type={message.eventType}
      data-event-id={message.eventId}
    >
      {typeof message.content.body === 'string' ? message.content.body : message.body}
    </div>
  ),
}));
vi.mock('./AgentStreamBubble', () => ({
  AgentStreamBubble: () => <div data-testid="stream-bubble" />,
}));

import { MessageList } from './MessageList';

/** 构造 ImMessage（默认普通 m.room.message） */
function makeMsg(overrides: Partial<ImMessage> & { eventId: string }): ImMessage {
  return {
    roomId: '!room:server',
    sender: '@bot:server',
    body: '',
    eventType: 'm.room.message',
    content: {},
    timestamp: 0,
    ...overrides,
  };
}

/** 把消息列表注入 mock store 后渲染 MessageList */
function renderWith(messages: ImMessage[]): void {
  imState.messagesByRoom = new Map([['!room:server', messages]]);
  render(<MessageList />);
}

beforeEach(() => {
  // jsdom 未实现 Element.scrollTo，MessageList 的滚动 useEffect 依赖它
  window.HTMLElement.prototype.scrollTo = () => {};
});

describe('MessageList v1.4 过滤', () => {
  it('过滤 io.momo-studio.dispatch 事件（不独立渲染）', () => {
    renderWith([
      makeMsg({ eventId: '$1', body: '普通消息' }),
      makeMsg({
        eventId: '$2',
        eventType: 'io.momo-studio.dispatch',
        content: { body: '委派内容' },
      }),
    ]);
    expect(screen.getByText('普通消息')).toBeInTheDocument();
    expect(screen.queryByText('委派内容')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('bubble')).toHaveLength(1);
  });

  it('过滤 io.momo-studio.task_reply 事件', () => {
    renderWith([
      makeMsg({ eventId: '$1', body: '用户提问' }),
      makeMsg({
        eventId: '$2',
        eventType: 'io.momo-studio.task_reply',
        content: { body: '回执内容' },
      }),
    ]);
    expect(screen.getByText('用户提问')).toBeInTheDocument();
    expect(screen.queryByText('回执内容')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('bubble')).toHaveLength(1);
  });

  it('过滤含 io.momo-studio.parent_stream_session_id 的 m.room.message', () => {
    renderWith([
      makeMsg({ eventId: '$1', body: 'PM 回复' }),
      makeMsg({
        eventId: '$2',
        body: '子 agent 嵌套回复',
        content: { body: '子 agent 嵌套回复', 'io.momo-studio.parent_stream_session_id': 'sess-1' },
      }),
    ]);
    expect(screen.getByText('PM 回复')).toBeInTheDocument();
    // 子 agent 回复被过滤（应由 PM 气泡的 dispatch chip 承载，不独立渲染）
    expect(screen.queryByText('子 agent 嵌套回复')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('bubble')).toHaveLength(1);
  });

  it('普通消息 + 三类过滤事件混合 → 仅普通消息渲染', () => {
    renderWith([
      makeMsg({ eventId: '$1', body: '第一条普通' }),
      makeMsg({
        eventId: '$2',
        eventType: 'io.momo-studio.dispatch',
        content: { body: '委派' },
      }),
      makeMsg({
        eventId: '$3',
        eventType: 'io.momo-studio.task_reply',
        content: { body: '回执' },
      }),
      makeMsg({
        eventId: '$4',
        body: '子回复',
        content: { body: '子回复', 'io.momo-studio.parent_stream_session_id': 'sess-x' },
      }),
      makeMsg({ eventId: '$5', body: '第二条普通' }),
    ]);
    const bubbles = screen.getAllByTestId('bubble');
    expect(bubbles).toHaveLength(2);
    expect(screen.getByText('第一条普通')).toBeInTheDocument();
    expect(screen.getByText('第二条普通')).toBeInTheDocument();
    expect(screen.queryByText('委派')).not.toBeInTheDocument();
    expect(screen.queryByText('回执')).not.toBeInTheDocument();
    expect(screen.queryByText('子回复')).not.toBeInTheDocument();
  });

  it('无 parent_stream_session_id 的普通 m.room.message 不被过滤', () => {
    renderWith([
      makeMsg({
        eventId: '$1',
        body: '正常 agent 回复',
        content: { 'io.momo-studio.stream_session_id': 'sess-9' },
      }),
    ]);
    // 仅含 stream_session_id（非 parent_）的消息应正常渲染
    expect(screen.getByText('正常 agent 回复')).toBeInTheDocument();
    expect(screen.getAllByTestId('bubble')).toHaveLength(1);
  });

  it('全部消息都被过滤时 → 渲染空（不报错，无 bubble）', () => {
    renderWith([
      makeMsg({
        eventId: '$1',
        eventType: 'io.momo-studio.dispatch',
        content: { body: '委派' },
      }),
    ]);
    expect(screen.queryAllByTestId('bubble')).toHaveLength(0);
  });
});
