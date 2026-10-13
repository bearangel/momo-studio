// electron/tests/agent/task-reply-ack.test.ts
//
// task_reply_ack 契约（boundary 规则 4：生产者真实产出 → 消费者直接消费）。
// process.send mock 遵循 test-rules 规则 1：真实 Node 内部读 this，以绑定对象方法形态提供。
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('task_reply_ack 全链', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sendTaskReplyAckEvent 产出正确信封（eventType + content.task_id）', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const send = function (this: { connected: boolean }, msg: Record<string, unknown>) {
      if (!this.connected) throw new Error('channel closed');
      calls.push(msg);
    };
    vi.stubGlobal('process', { ...process, send: send.bind({ connected: true }), connected: true });
    const { sendTaskReplyAckEvent } = await import('../../src/main/agent/internal-event');
    sendTaskReplyAckEvent('sess-1', 'agent-pm-1', { task_id: 't-ack-1' });
    expect(calls[0]).toMatchObject({
      type: 'momo-internal-event',
      eventType: 'io.momo-studio.task_reply_ack',
      sessionId: 'sess-1',
      sender: 'agent-pm-1',
      content: { task_id: 't-ack-1' },
    });
  });

  it('RouterService.applyRegistryAck → registry.markConsumed（delivered=true）', async () => {
    const { dispatchRegistry, __resetDispatchRegistryForTest } = await import('../../src/main/agent/dispatch-registry');
    __resetDispatchRegistryForTest();
    dispatchRegistry.register({ taskId: 't-ack-2', pmAssignmentId: 'pm', subAssignmentId: 'sub', sessionId: 's', isFollowupRound: false });
    dispatchRegistry.settle('t-ack-2', 'completed', 'ok');
    const { RouterService } = await import('../../src/main/agent/router-service');
    const svc = new RouterService({ runners: new Map() });
    svc.applyRegistryAck({ task_id: 't-ack-2' });
    expect(dispatchRegistry.get('t-ack-2')?.delivered).toBe(true);
    // 非法载荷 no-op
    expect(() => svc.applyRegistryAck({})).not.toThrow();
  });
});
