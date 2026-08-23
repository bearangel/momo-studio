// electron/tests/agent/internal-event-bridge.test.ts
//
// v2（P1 Task 5）：内部事件桥测试。
//
// 覆盖两侧契约：
//   主进程侧（internal-event-bridge）：
//     1. dispatch 内部事件 → routeEvent 被以正确 InternalEvent 形状调用（'owner', null）
//     2. 非内部事件（StreamChunk / task-end / 非法值）→ 返回 false 不消费
//     3. RouterService 未注入 → 返回 true（已消费）+ 不抛错（事件丢弃）
//     4. routeEvent reject → 不产生 unhandled rejection
//     5. setBridgeRouter(null) 后恢复"未注入"行为
//   子进程侧（internal-event）：
//     6. sendDispatchEvent / sendTaskReplyEvent / sendAbortDispatchEvent →
//        process.send 收到 { type: 'momo-internal-event', eventType, sessionId, sender, content } 信封
//     7. process.send 不存在（非 fork 环境）→ 不抛错

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setBridgeRouter,
  handleChildMessage,
} from '../../src/main/agent/internal-event-bridge';
import {
  sendDispatchEvent,
  sendTaskReplyEvent,
  sendAbortDispatchEvent,
  INTERNAL_EVENT_MSG,
} from '../../src/main/agent/internal-event';
import {
  DISPATCH_EVENT_TYPE,
  TASK_REPLY_EVENT_TYPE,
  ABORT_DISPATCH_EVENT_TYPE,
} from '../../src/main/agent/dispatch';

/** 与 RouterService.routeEvent 签名兼容的 mock router */
function mkMockRouter() {
  return { routeEvent: vi.fn().mockResolvedValue(undefined) };
}

describe('主进程侧：handleChildMessage（child IPC → RouterService）', () => {
  let router: ReturnType<typeof mkMockRouter>;

  beforeEach(() => {
    router = mkMockRouter();
    setBridgeRouter(router);
  });

  afterEach(() => {
    setBridgeRouter(null);
  });

  it('dispatch 内部事件 → routeEvent 以正确 InternalEvent 形状调用', () => {
    const content = {
      body: '写登录页',
      task_id: 'task-1',
      dispatch_from: '@pm:home',
      dispatch_to: '@sub:home',
    };
    const consumed = handleChildMessage({
      type: INTERNAL_EVENT_MSG,
      eventType: DISPATCH_EVENT_TYPE,
      sessionId: '!room:home',
      sender: '@pm:home',
      content,
    });

    expect(consumed).toBe(true);
    expect(router.routeEvent).toHaveBeenCalledTimes(1);

    const [event, ownerUserId, targetAssignmentId] = vi.mocked(router.routeEvent).mock.calls[0]!;
    expect(event.getType()).toBe(DISPATCH_EVENT_TYPE);
    expect(event.getContent()).toEqual(content);
    expect(event.getSender()).toBe('@pm:home');
    expect(event.getRoomId()).toBe('!room:home');
    expect(ownerUserId).toBe('owner');
    expect(targetAssignmentId).toBe(null);
  });

  it('task_reply / abort_dispatch 内部事件同样转发（eventType 透传）', () => {
    for (const eventType of [TASK_REPLY_EVENT_TYPE, ABORT_DISPATCH_EVENT_TYPE]) {
      expect(handleChildMessage({
        type: INTERNAL_EVENT_MSG,
        eventType,
        sessionId: '!room:home',
        sender: '@sub:home',
        content: { task_id: 'task-1', status: 'completed', body: 'done' },
      })).toBe(true);
    }
    expect(router.routeEvent).toHaveBeenCalledTimes(2);
    const types = vi.mocked(router.routeEvent).mock.calls.map(([e]) => e.getType());
    expect(types).toEqual([TASK_REPLY_EVENT_TYPE, ABORT_DISPATCH_EVENT_TYPE]);
  });

  it('StreamChunk / task-end / 非法消息 → 返回 false 不消费', () => {
    router = mkMockRouter();
    setBridgeRouter(router);

    expect(handleChildMessage({ type: 'start', streamSessionId: 's1', sessionId: '!r', senderAgentId: '@b:h' })).toBe(false);
    expect(handleChildMessage({ type: 'text', streamSessionId: 's1', delta: 'x' })).toBe(false);
    expect(handleChildMessage({ type: 'task-end', streamSessionId: 's1', taskId: null })).toBe(false);
    expect(handleChildMessage(null)).toBe(false);
    expect(handleChildMessage('string-msg')).toBe(false);
    expect(handleChildMessage(42)).toBe(false);
    expect(handleChildMessage({})).toBe(false);
    // type 对但 eventType 缺失 / 非字符串 → 视为非内部事件
    expect(handleChildMessage({ type: INTERNAL_EVENT_MSG })).toBe(false);
    expect(handleChildMessage({ type: INTERNAL_EVENT_MSG, eventType: 123 })).toBe(false);

    expect(router.routeEvent).not.toHaveBeenCalled();
  });

  it('RouterService 未注入 → 返回 true（已消费）且不抛错', () => {
    setBridgeRouter(null);
    expect(() =>
      handleChildMessage({
        type: INTERNAL_EVENT_MSG,
        eventType: DISPATCH_EVENT_TYPE,
        sessionId: '!room:home',
        sender: '@pm:home',
        content: { body: 'x' },
      }),
    ).not.toThrow();
    expect(handleChildMessage({
      type: INTERNAL_EVENT_MSG,
      eventType: DISPATCH_EVENT_TYPE,
      sessionId: '!room:home',
      sender: '@pm:home',
      content: { body: 'x' },
    })).toBe(true);
  });

  it('routeEvent reject → 不产生 unhandled rejection，消息仍视为已消费', async () => {
    const rejecting = { routeEvent: vi.fn().mockRejectedValue(new Error('router boom')) };
    setBridgeRouter(rejecting);

    let unhandled: unknown = null;
    const onUnhandled = (err: unknown): void => { unhandled = err; };
    process.on('unhandledRejection', onUnhandled);
    try {
      expect(handleChildMessage({
        type: INTERNAL_EVENT_MSG,
        eventType: DISPATCH_EVENT_TYPE,
        sessionId: '!room:home',
        sender: '@pm:home',
        content: { body: 'x' },
      })).toBe(true);
      // routeEvent 是 fire-and-forget；给微任务队列一个Flush机会
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toBe(null);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('子进程侧：send*Event（process.send 信封契约）', () => {
  const originalSend = process.send;
  let sent: unknown[];

  beforeEach(() => {
    sent = [];
    process.send = ((msg: unknown): boolean => {
      sent.push(msg);
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
  });

  it('sendDispatchEvent → momo-internal-event 信封 + dispatch eventType', () => {
    const content = { body: 'task', task_id: 't1', dispatch_from: '@pm:h', dispatch_to: '@sub:h' };
    sendDispatchEvent('!room:h', '@pm:h', content);
    expect(sent).toEqual([{
      type: INTERNAL_EVENT_MSG,
      eventType: DISPATCH_EVENT_TYPE,
      sessionId: '!room:h',
      sender: '@pm:h',
      content,
    }]);
  });

  it('sendTaskReplyEvent → task_reply eventType', () => {
    sendTaskReplyEvent('!room:h', '@sub:h', { task_id: 't1', status: 'completed', body: 'ok' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: INTERNAL_EVENT_MSG,
      eventType: TASK_REPLY_EVENT_TYPE,
      sessionId: '!room:h',
      sender: '@sub:h',
    });
  });

  it('sendAbortDispatchEvent → abort_dispatch eventType', () => {
    sendAbortDispatchEvent('!room:h', '@pm:h', { task_id: 't1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: INTERNAL_EVENT_MSG,
      eventType: ABORT_DISPATCH_EVENT_TYPE,
      sessionId: '!room:h',
      sender: '@pm:h',
    });
  });

  it('process.send 不存在（非 fork 环境）→ 不抛错', () => {
    // process.send 是可选属性（非 fork 环境为 undefined），直接置空模拟
    process.send = undefined;
    expect(() => sendDispatchEvent('!room:h', '@pm:h', {})).not.toThrow();
  });
});
