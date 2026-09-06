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
const { sessionState } = vi.hoisted(() => ({
  sessionState: {
    activeSessionId: 'sess-room',
    messagesBySession: new Map<string, ImMessage[]>(),
    loading: false,
    loadingOlderBySession: new Map<string, boolean>(),
    hasMoreBySession: new Map<string, boolean>(),
    loadOlder: () => Promise.resolve(),
  },
}));

vi.mock('../../stores/session.store', () => ({
  useSessionStore: (selector: (s: typeof sessionState) => unknown) => selector(sessionState),
}));
vi.mock('../../stores/stream.store', () => ({
  // mock 形状对齐真实 zustand store 接口：selector 访问 + subscribe（v2.2 起
  // MessageList 经 subscribe 做流式贴底，缺该方法会让本组件直接崩溃）
  useStreamStore: Object.assign(
    (selector: (s: { streams: Map<string, unknown> }) => unknown) =>
      selector({ streams: new Map() }),
    { subscribe: () => () => {} },
  ),
}));
vi.mock('../../lib/useBotNames', () => ({
  useBotNameMap: () => new Map(),
}));

// 桩 MessageBubble：渲染 body + data-event-type/data-msg-id，便于断言通过过滤的消息
// v2.0 A 子系统：改读 m.id / m.body（不再读 eventId / content.body）
vi.mock('./MessageBubble', () => ({
  MessageBubble: ({ message }: { message: ImMessage }) => (
    <div
      data-testid="bubble"
      data-event-type={message.eventType}
      data-msg-id={message.id}
    >
      {message.body}
    </div>
  ),
}));
vi.mock('./AgentStreamBubble', () => ({
  AgentStreamBubble: () => <div data-testid="stream-bubble" />,
}));

import { MessageList } from './MessageList';

/** 构造 ImMessage（默认普通 m.room.message）。v2.0 A 子系统：字段对齐 SQLite messages 表 row */
function makeMsg(overrides: Partial<ImMessage> & { id: string }): ImMessage {
  return {
    sessionId: 'sess-room',
    sender: '@bot:server',
    body: '',
    eventType: 'm.room.message',
    streamSessionId: null,
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'done',
    source: 'local',
    workspaceId: null,
    taskId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 把消息列表注入 mock store 后渲染 MessageList */
function renderWith(messages: ImMessage[]): void {
  sessionState.messagesBySession = new Map([['sess-room', messages]]);
  render(<MessageList />);
}

beforeEach(() => {
  // jsdom 未实现 Element.scrollTo，MessageList 的滚动 useEffect 依赖它
  window.HTMLElement.prototype.scrollTo = () => {};
});

describe('MessageList v1.4 过滤', () => {
  it('过滤 io.momo-studio.dispatch 事件（不独立渲染）', () => {
    renderWith([
      makeMsg({ id: 'm1', body: '普通消息' }),
      makeMsg({
        id: 'm2',
        body: '委派内容',
        eventType: 'io.momo-studio.dispatch',
      }),
    ]);
    expect(screen.getByText('普通消息')).toBeInTheDocument();
    expect(screen.queryByText('委派内容')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('bubble')).toHaveLength(1);
  });

  it('过滤 io.momo-studio.task_reply 事件', () => {
    renderWith([
      makeMsg({ id: 'm1', body: '用户提问' }),
      makeMsg({
        id: 'm2',
        body: '回执内容',
        eventType: 'io.momo-studio.task_reply',
      }),
    ]);
    expect(screen.getByText('用户提问')).toBeInTheDocument();
    expect(screen.queryByText('回执内容')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('bubble')).toHaveLength(1);
  });

  it('过滤含 parentStreamSessionId 的 m.room.message', () => {
    renderWith([
      makeMsg({ id: 'm1', body: 'PM 回复' }),
      makeMsg({
        id: 'm2',
        body: '子 agent 嵌套回复',
        parentStreamSessionId: 'sess-1',
      }),
    ]);
    expect(screen.getByText('PM 回复')).toBeInTheDocument();
    // 子 agent 回复被过滤（应由 PM 气泡的 dispatch chip 承载，不独立渲染）
    expect(screen.queryByText('子 agent 嵌套回复')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('bubble')).toHaveLength(1);
  });

  it('普通消息 + 三类过滤事件混合 → 仅普通消息渲染', () => {
    renderWith([
      makeMsg({ id: 'm1', body: '第一条普通' }),
      makeMsg({
        id: 'm2',
        body: '委派',
        eventType: 'io.momo-studio.dispatch',
      }),
      makeMsg({
        id: 'm3',
        body: '回执',
        eventType: 'io.momo-studio.task_reply',
      }),
      makeMsg({
        id: 'm4',
        body: '子回复',
        parentStreamSessionId: 'sess-x',
      }),
      makeMsg({ id: 'm5', body: '第二条普通' }),
    ]);
    const bubbles = screen.getAllByTestId('bubble');
    expect(bubbles).toHaveLength(2);
    expect(screen.getByText('第一条普通')).toBeInTheDocument();
    expect(screen.getByText('第二条普通')).toBeInTheDocument();
    expect(screen.queryByText('委派')).not.toBeInTheDocument();
    expect(screen.queryByText('回执')).not.toBeInTheDocument();
    expect(screen.queryByText('子回复')).not.toBeInTheDocument();
  });

  it('无 parentStreamSessionId 的普通 m.room.message 不被过滤', () => {
    renderWith([
      makeMsg({
        id: 'm1',
        body: '正常 agent 回复',
        streamSessionId: 'sess-9',
      }),
    ]);
    // 仅含 streamSessionId（非 parent_）的消息应正常渲染
    expect(screen.getByText('正常 agent 回复')).toBeInTheDocument();
    expect(screen.getAllByTestId('bubble')).toHaveLength(1);
  });

  it('全部消息都被过滤时 → 渲染空（不报错，无 bubble）', () => {
    renderWith([
      makeMsg({
        id: 'm1',
        body: '委派',
        eventType: 'io.momo-studio.dispatch',
      }),
    ]);
    expect(screen.queryAllByTestId('bubble')).toHaveLength(0);
  });
});

// === 发送即贴底（2026-09-06 UI 修复） ===
// 契约：用户在上方浏览历史（isNearBottom=false）时，自己发送的消息追加
// （末尾 sender='owner' 且 id 新增）→ 无条件贴底并恢复跟随；追加的是
// agent 消息则维持原策略（不打断浏览）。
import { fireEvent } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';

/** 渲染并返回 rerender（供消息追加场景） */
function renderForRerender(messages: ImMessage[]): RenderResult {
  sessionState.messagesBySession = new Map([['sess-room', messages]]);
  return render(<MessageList />);
}

/** 重渲染注入新消息列表 */
function rerenderWith(rerender: RenderResult['rerender'], messages: ImMessage[]): void {
  sessionState.messagesBySession = new Map([['sess-room', messages]]);
  rerender(<MessageList />);
}

/** 拿到滚动容器（列表根元素） */
function getScrollEl(): HTMLElement {
  const el = document.querySelector('.overflow-y-auto');
  if (!(el instanceof HTMLElement)) throw new Error('scroll container not found');
  return el;
}

/** jsdom 滚动属性可控化：scrollHeight/clientHeight 只读 → defineProperty */
function controlScroll(el: HTMLElement, props: { scrollHeight: number; clientHeight: number; scrollTop: number }): void {
  Object.defineProperty(el, 'scrollHeight', { value: props.scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: props.clientHeight, configurable: true });
  el.scrollTop = props.scrollTop;
}

async function flushEffects(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('MessageList 发送即贴底', () => {
  it('浏览历史时发送自己的消息 → 强制贴底（无视 isNearBottom）', async () => {
    const { rerender } = renderForRerender([makeMsg({ id: 'a1', body: '旧消息' })]);
    const el = getScrollEl();
    controlScroll(el, { scrollHeight: 1000, clientHeight: 600, scrollTop: 200 });
    fireEvent.scroll(el); // 距底 200px > 120 → isNearBottom=false
    const scrollTo = vi.spyOn(el, 'scrollTo');
    scrollTo.mockClear();

    rerenderWith(rerender, [
      makeMsg({ id: 'a1', body: '旧消息' }),
      makeMsg({ id: 'own-1', sender: 'owner', body: '我刚发送的' }),
    ]);
    await flushEffects();
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' });
  });

  it('浏览历史时追加 agent 消息 → 不贴底（不打断浏览）', async () => {
    const { rerender } = renderForRerender([makeMsg({ id: 'a1', body: '旧消息' })]);
    const el = getScrollEl();
    controlScroll(el, { scrollHeight: 1000, clientHeight: 600, scrollTop: 200 });
    fireEvent.scroll(el);
    const scrollTo = vi.spyOn(el, 'scrollTo');
    scrollTo.mockClear();

    rerenderWith(rerender, [
      makeMsg({ id: 'a1', body: '旧消息' }),
      makeMsg({ id: 'a2', body: 'agent 新回复' }),
    ]);
    await flushEffects();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
