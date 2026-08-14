// electron/tests/agent/router-service.test.ts
//
// RouterService 测试——task-driven 架构的消息路由中心。
// 覆盖 3 条核心路由：
//   1. m.room.message → ephemeral chat task → AgentRunner.executeTask
//   2. io.momo-studio.dispatch → dispatch ephemeral task（含 dispatchContext）→ AgentRunner.executeTask
//   3. io.momo-studio.task_reply → 通知正在执行的 PM runtime → AgentRunner.notifyTaskReply
//
// AgentRunner / TaskDispatcher 用 mock（与 agent-runner.test.ts 同模式，避免真实子进程）。

import { describe, it, expect, vi } from 'vitest';
import { RouterService } from '../../src/main/agent/router-service';

/**
 * 构造 mock Matrix event——只暴露 RouterService.routeMatrixEvent 用到的方法。
 * 与真实 matrix-js-sdk MatrixEvent 的子集形状一致。
 */
function mkMockEvent(
  type: string,
  content: Record<string, unknown>,
  sender = '@user:home',
  roomId = '!room:home',
) {
  return {
    getType: () => type,
    getContent: () => content,
    getSender: () => sender,
    getRoomId: () => roomId,
    getId: () => '$evt:home',
    getTs: () => Date.now(),
    isRedacted: () => false,
  } as never;
}

describe('RouterService', () => {
  it('m.room.message → 路由到目标 agent → executeTask', async () => {
    const mockRunner = { executeTask: vi.fn().mockResolvedValue({ streamSessionId: 'ss-1' }) };
    const runners = new Map([['inst1', mockRunner]]);
    const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });

    await svc.routeMatrixEvent(
      mkMockEvent('m.room.message', { body: 'hello', 'm.mentions': {} }),
      '@user:home',
      '!room:home',
      'inst1',
    );

    expect(mockRunner.executeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: null,
        body: 'hello',
      }),
    );
  });

  it('dispatch event → 路由到子 agent → executeTask（dispatchContext）', async () => {
    const mockRunner = { executeTask: vi.fn().mockResolvedValue({ streamSessionId: 'ss-2' }) };
    const runners = new Map([['inst-sub', mockRunner]]);
    const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });

    await svc.routeMatrixEvent(
      mkMockEvent('io.momo-studio.dispatch', {
        body: '写登录页',
        task_id: 'task-123',
        dispatch_from: '@pm:home',
        dispatch_to: '@sub:home',
      }),
      '@pm:home',
      '!room:home',
      'inst-sub',
    );

    expect(mockRunner.executeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-123',
        dispatchContext: expect.objectContaining({ fromBotUserId: '@pm:home' }),
      }),
    );
  });

  it('task_reply → 通知正在执行的 PM task（IPC 推送）', async () => {
    const mockRunner = {
      executeTask: vi.fn(),
      notifyTaskReply: vi.fn(),
    };
    const runners = new Map([['inst-pm', mockRunner]]);
    const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });

    await svc.routeMatrixEvent(
      mkMockEvent('io.momo-studio.task_reply', {
        body: '完成',
        task_id: 'task-123',
        status: 'completed',
      }),
      '@sub:home',
      '!room:home',
      'inst-pm',
    );

    expect(mockRunner.notifyTaskReply).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-123' }),
    );
  });
});
