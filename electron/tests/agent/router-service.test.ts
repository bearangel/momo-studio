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

  it('dispatch 未传 directTargetAssignmentId 时从 dispatch_to 自解析', async () => {
    const mockRunner = { executeTask: vi.fn().mockResolvedValue({ streamSessionId: 'ss-3' }) };
    const runners = new Map([['inst-sub', mockRunner]]);
    const findAssignmentByBotUserId = vi.fn((botUserId: string) => {
      if (botUserId === '@sub:home') return 'inst-sub';
      return null;
    });
    const svc = new RouterService({
      runners,
      dispatcher: { tryPickup: vi.fn() } as never,
      findAssignmentByBotUserId,
    });

    await svc.routeMatrixEvent(
      mkMockEvent('io.momo-studio.dispatch', {
        body: '写测试',
        task_id: 'task-456',
        dispatch_from: '@pm:home',
        dispatch_to: '@sub:home',
      }),
      '@pm:home',
      null,
    );

    expect(findAssignmentByBotUserId).toHaveBeenCalledWith('@sub:home');
    expect(mockRunner.executeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-456',
        dispatchContext: expect.objectContaining({ fromBotUserId: '@pm:home' }),
      }),
    );
  });

  it('dispatch 自解析失败（findAssignmentByBotUserId 返回 null）时不派发', async () => {
    const mockRunner = { executeTask: vi.fn() };
    const runners = new Map([['inst-sub', mockRunner]]);
    const findAssignmentByBotUserId = vi.fn(() => null);
    const svc = new RouterService({
      runners,
      dispatcher: { tryPickup: vi.fn() } as never,
      findAssignmentByBotUserId,
    });

    await svc.routeMatrixEvent(
      mkMockEvent('io.momo-studio.dispatch', {
        body: '写测试',
        task_id: 'task-789',
        dispatch_from: '@pm:home',
        dispatch_to: '@unknown:home',
      }),
      '@pm:home',
      null,
    );

    expect(mockRunner.executeTask).not.toHaveBeenCalled();
  });

  it('task_reply 带 reply_to 时精确路由到目标 PM（不广播）', async () => {
    const pmRunner = { executeTask: vi.fn(), notifyTaskReply: vi.fn() };
    const otherRunner = { executeTask: vi.fn(), notifyTaskReply: vi.fn() };
    const runners = new Map([
      ['inst-pm', pmRunner],
      ['inst-other', otherRunner],
    ]);
    const findAssignmentByBotUserId = vi.fn((botUserId: string) => {
      if (botUserId === '@pm:home') return 'inst-pm';
      return null;
    });
    const svc = new RouterService({
      runners,
      dispatcher: { tryPickup: vi.fn() } as never,
      findAssignmentByBotUserId,
    });

    await svc.routeMatrixEvent(
      mkMockEvent('io.momo-studio.task_reply', {
        body: '完成',
        task_id: 'task-123',
        status: 'completed',
        reply_to: '@pm:home',
      }),
      '@sub:home',
      '!room:home',
    );

    expect(findAssignmentByBotUserId).toHaveBeenCalledWith('@pm:home');
    expect(pmRunner.notifyTaskReply).toHaveBeenCalledTimes(1);
    expect(otherRunner.notifyTaskReply).not.toHaveBeenCalled();
  });

  it('task_reply 无 reply_to 且无 assignmentId 时广播（向后兼容）', async () => {
    const r1 = { executeTask: vi.fn(), notifyTaskReply: vi.fn() };
    const r2 = { executeTask: vi.fn(), notifyTaskReply: vi.fn() };
    const runners = new Map([
      ['inst-1', r1],
      ['inst-2', r2],
    ]);
    const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });

    await svc.routeMatrixEvent(
      mkMockEvent('io.momo-studio.task_reply', {
        body: '完成',
        task_id: 'task-old',
        status: 'completed',
      }),
      '@sub:home',
      null,
    );

    expect(r1.notifyTaskReply).toHaveBeenCalledTimes(1);
    expect(r2.notifyTaskReply).toHaveBeenCalledTimes(1);
  });
});
