// renderer/src/components/im/MessageList.autoscroll.test.tsx
//
// v2.2 bug 修复回归锁：agent 生成过程中流式内容增长发生在 stream.store
// （applyEventBatch 聚合），messages 引用不变——旧滚动 effect 只依赖
// [messages, activeSessionId]，流式期间永不触发，滚动条不贴底。
// 本文件用真实 session.store + 真实 stream.store 驱动（mock 收窄：仅
// useBotNames 与 MessageBubble 桩），jsdom 无布局——scrollHeight/clientHeight
// 经 defineProperty 手工模拟内容增长。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act, waitFor } from '@testing-library/react';
import type { ImMessage, MessageEventRow } from '../../ipc/types';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore } from '../../stores/stream.store';

vi.mock('../../lib/useBotNames', () => ({
  useBotNameMap: () => new Map(),
}));

vi.mock('./MessageBubble', () => ({
  MessageBubble: ({ message }: { message: ImMessage }) => (
    <div data-testid="bubble" data-msg-id={message.id}>
      {message.body}
    </div>
  ),
}));

import { MessageList } from './MessageList';

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
    status: 'streaming',
    source: 'local',
    workspaceId: null,
    taskId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function textDelta(messageId: string, seq: number, delta: string): MessageEventRow {
  return {
    id: `ev-${messageId}-${seq}`,
    messageId,
    seq,
    eventType: 'text_delta',
    payload: { delta },
    createdAt: Date.now(),
  };
}

let scrollHeightValue = 1000;
const scrollToCalls: Array<{ top: number }> = [];

function seedSession(messages: ImMessage[]): void {
  useSessionStore.setState({
    activeSessionId: 'sess-room',
    messagesBySession: new Map([['sess-room', messages]]),
    loading: false,
    loadingOlderBySession: new Map(),
    hasMoreBySession: new Map(),
    loadOlder: () => Promise.resolve(),
  });
}

/** 渲染并接管滚动容器的布局属性，返回容器元素 */
function renderAndStubLayout(): HTMLElement {
  const { container } = render(<MessageList />);
  const el = container.querySelector<HTMLElement>('.overflow-y-auto');
  if (!el) throw new Error('滚动容器未找到');
  Object.defineProperty(el, 'scrollHeight', {
    get: () => scrollHeightValue,
    configurable: true,
  });
  Object.defineProperty(el, 'clientHeight', { get: () => 400, configurable: true });
  return el;
}

beforeEach(() => {
  scrollHeightValue = 1000;
  scrollToCalls.length = 0;
  useStreamStore.getState().reset();
  // 兼容 Element.scrollTo 双重载（options 对象 / x,y 数值）；MessageList 只用前者
  window.HTMLElement.prototype.scrollTo = function (
    this: HTMLElement,
    x?: number | ScrollToOptions,
    y?: number,
  ) {
    const top = typeof x === 'number' ? x : (x?.top ?? y ?? 0);
    scrollToCalls.push({ top });
    this.scrollTop = top;
  };
});

describe('MessageList 流式生成自动贴底（v2.2 修复）', () => {
  it('流式 events 到达（messages 引用不变）→ 贴底跟随滚动到新底部', async () => {
    seedSession([makeMsg({ id: 'm1', streamSessionId: 'ss-1' })]);
    renderAndStubLayout();
    scrollToCalls.length = 0;

    act(() => {
      scrollHeightValue = 1600;
      useStreamStore.getState().applyEventBatch([textDelta('m1', 1, '内容增长')]);
    });

    await waitFor(() => {
      expect(scrollToCalls.some((c) => c.top === 1600)).toBe(true);
    });
  });

  it('用户滚离底部（> 120px）→ 流式增长不强制拉回底部', async () => {
    seedSession([makeMsg({ id: 'm1', streamSessionId: 'ss-1' })]);
    const el = renderAndStubLayout();
    scrollToCalls.length = 0;

    el.scrollTop = 0;
    fireEvent.scroll(el);

    act(() => {
      scrollHeightValue = 1600;
      useStreamStore.getState().applyEventBatch([textDelta('m1', 1, '内容增长')]);
    });

    await new Promise((r) => setTimeout(r, 120));
    expect(scrollToCalls.some((c) => c.top === 1600)).toBe(false);
  });

  it('新消息行到达（messages 变化）→ 贴底滚动（既有行为不回归）', async () => {
    seedSession([makeMsg({ id: 'm1', streamSessionId: 'ss-1' })]);
    renderAndStubLayout();
    scrollToCalls.length = 0;
    scrollHeightValue = 1600;

    act(() => {
      const cur = useSessionStore.getState().messagesBySession.get('sess-room') ?? [];
      useSessionStore.setState({
        messagesBySession: new Map([['sess-room', [...cur, makeMsg({ id: 'm2' })]]]),
      });
    });

    await waitFor(() => {
      expect(scrollToCalls.some((c) => c.top === 1600)).toBe(true);
    });
  });
});
