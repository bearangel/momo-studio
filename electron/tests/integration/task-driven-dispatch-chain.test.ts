// electron/tests/integration/task-driven-dispatch-chain.test.ts
//
// I4 修复：验证 task-driven 模式的完整 dispatch 链路。
//
// 与 task-driven-e2e.test.ts 的区别：
//   e2e 测试验证的是"数据层"（INSERT message + append chunk → 聚合正确性）。
//   本测试验证的是"dispatch 链路"：
//     Matrix event → RouterService.routeMatrixEvent → AgentRunner.executeTask 被调用
//
// 覆盖 C1 修复后的核心链路：
//   1. m.room.message + directTargetAssignmentId → routeUserMessage → executeTask
//   2. m.room.message + directTargetAssignmentId=null → 不派发（验证 guard）
//   3. dispatch event → routeDispatch → executeTask（含 dispatchContext）
//   4. task_reply + reply_to → 精确路由 → notifyTaskReply
//   5. task_reply 无 reply_to → 广播 → 所有 runner 收到 notifyTaskReply
import { describe, it, expect, vi } from 'vitest';
import { RouterService } from '../../src/main/agent/router-service';

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
    getId: () => `$evt-${Math.random()}:home`,
    getTs: () => Date.now(),
    isRedacted: () => false,
  } as never;
}

describe('task-driven dispatch chain（Matrix event → RouterService → AgentRunner）', () => {
  it('m.room.message + directTarget → executeTask 被调用（C1 核心链路）', async () => {
    const mockRunner = {
      executeTask: vi.fn().mockResolvedValue({ streamSessionId: 'ss-1' }),
      notifyTaskReply: vi.fn(),
    };
    const runners = new Map([['inst-pm', mockRunner]]);
    const svc = new RouterService({
      runners,
      dispatcher: { tryPickup: vi.fn() } as never,
    });

    await svc.routeMatrixEvent(
      mkMockEvent('m.room.message', { body: '你好，帮我做事' }),
      '@user:home',
      '!room:home',
      'inst-pm',
    );

    expect(mockRunner.executeTask).toHaveBeenCalledTimes(1);
    expect(mockRunner.executeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: null,
        body: '你好，帮我做事',
        executionRoomId: '!room:home',
      }),
    );
  });

  it('m.room.message + directTarget=null → executeTask 不被调用（验证 guard）', async () => {
    const mockRunner = {
      executeTask: vi.fn(),
      notifyTaskReply: vi.fn(),
    };
    const runners = new Map([['inst-pm', mockRunner]]);
    const svc = new RouterService({
      runners,
      dispatcher: { tryPickup: vi.fn() } as never,
    });

    await svc.routeMatrixEvent(
      mkMockEvent('m.room.message', { body: '这条消息不会被派发' }),
      '@user:home',
      null,
    );

    expect(mockRunner.executeTask).not.toHaveBeenCalled();
  });

  it('dispatch event → routeDispatch → executeTask（含 dispatchContext）', async () => {
    const mockRunner = {
      executeTask: vi.fn().mockResolvedValue({ streamSessionId: 'ss-dispatch' }),
      notifyTaskReply: vi.fn(),
    };
    const runners = new Map([['inst-sub', mockRunner]]);
    const svc = new RouterService({
      runners,
      dispatcher: { tryPickup: vi.fn() } as never,
    });

    await svc.routeMatrixEvent(
      mkMockEvent('io.momo-studio.dispatch', {
        body: '写登录页',
        task_id: 'task-dispatch-1',
        dispatch_from: '@pm:home',
        dispatch_to: '@sub:home',
      }),
      '@pm:home',
      '!room:home',
      'inst-sub',
    );

    expect(mockRunner.executeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-dispatch-1',
        body: '写登录页',
        dispatchContext: expect.objectContaining({
          fromBotUserId: '@pm:home',
          task_id: 'task-dispatch-1',
        }),
      }),
    );
  });

  it('task_reply + reply_to → 精确路由到 PM runner（不广播）', async () => {
    const pmRunner = {
      executeTask: vi.fn(),
      notifyTaskReply: vi.fn(),
    };
    const otherRunner = {
      executeTask: vi.fn(),
      notifyTaskReply: vi.fn(),
    };
    const runners = new Map([
      ['inst-pm', pmRunner],
      ['inst-other', otherRunner],
    ]);
    const svc = new RouterService({
      runners,
      dispatcher: { tryPickup: vi.fn() } as never,
      findAssignmentByBotUserId: (botUserId) =>
        botUserId === '@pm:home' ? 'inst-pm' : null,
    });

    await svc.routeMatrixEvent(
      mkMockEvent(
        'io.momo-studio.task_reply',
        {
          body: '完成',
          task_id: 'task-reply-1',
          status: 'completed',
          reply_to: '@pm:home',
        },
        '@sub:home',
      ),
      '@sub:home',
      null,
    );

    expect(pmRunner.notifyTaskReply).toHaveBeenCalledTimes(1);
    expect(otherRunner.notifyTaskReply).not.toHaveBeenCalled();
  });

  it('task_reply 无 reply_to → 广播所有 runner（向后兼容）', async () => {
    const r1 = { executeTask: vi.fn(), notifyTaskReply: vi.fn() };
    const r2 = { executeTask: vi.fn(), notifyTaskReply: vi.fn() };
    const runners = new Map([
      ['inst-1', r1],
      ['inst-2', r2],
    ]);
    const svc = new RouterService({
      runners,
      dispatcher: { tryPickup: vi.fn() } as never,
    });

    await svc.routeMatrixEvent(
      mkMockEvent(
        'io.momo-studio.task_reply',
        {
          body: '旧格式回执',
          task_id: 'task-old',
          status: 'completed',
        },
        '@sub:home',
      ),
      '@sub:home',
      null,
    );

    expect(r1.notifyTaskReply).toHaveBeenCalledTimes(1);
    expect(r2.notifyTaskReply).toHaveBeenCalledTimes(1);
  });
});
