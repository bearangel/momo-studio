// electron/tests/agent/router-service.test.ts
//
// RouterService 测试——task-driven 架构的消息路由中心。
// 覆盖核心路由：
//   1. routeUserChat：plain 参数入口，直接派发 ephemeral chat task → AgentRunner.executeTask
//   2. routeEvent：按 Matrix event 类型分流
//      - m.room.message → routeUserChat（内部）→ executeTask
//      - io.momo-studio.dispatch → routeDispatch → executeTask（含 dispatchContext）
//      - io.momo-studio.task_reply → 通知正在执行的 PM runtime → AgentRunner.notifyTaskReply
//
// AgentRunner / TaskDispatcher 用 mock（与 agent-runner.test.ts 同模式，避免真实子进程）。

import { describe, it, expect, vi } from 'vitest';
import { RouterService } from '../../src/main/agent/router-service';

/**
 * 构造 mock Matrix event——只暴露 RouterService.routeEvent 用到的方法。
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
  describe('routeUserChat（plain 参数入口）', () => {
    it('routeUserChat 直接派发 ephemeral task 到目标 runner（不经过 event 形状）', async () => {
      const mockRunner = { executeTask: vi.fn().mockResolvedValue({ streamSessionId: 'ss-plain' }) };
      const runners = new Map([['inst-pm', mockRunner]]);
      const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });

      await svc.routeUserChat({
        sessionId: '!room:home',
        assignmentId: 'inst-pm',
        body: '你好',
      });

      expect(mockRunner.executeTask).toHaveBeenCalledTimes(1);
      const calledWith = mockRunner.executeTask.mock.calls[0][0];
      expect(calledWith.taskId).toBeNull();
      expect(calledWith.executionSessionId).toBe('!room:home');
      expect(calledWith.body).toBe('你好');
      // 未传 streamSessionId → 自动生成 UUID
      expect(typeof calledWith.streamSessionId).toBe('string');
      expect(calledWith.streamSessionId.length).toBeGreaterThan(0);
    });

    it('routeUserChat 传入 streamSessionId 时尊重入参（不重写）', async () => {
      const mockRunner = { executeTask: vi.fn().mockResolvedValue({ streamSessionId: 'ss-x' }) };
      const runners = new Map([['inst-pm', mockRunner]]);
      const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });

      await svc.routeUserChat({
        sessionId: '!room:home',
        assignmentId: 'inst-pm',
        body: '继续',
        streamSessionId: 'ss-explicit',
      });

      expect(mockRunner.executeTask).toHaveBeenCalledWith(
        expect.objectContaining({ streamSessionId: 'ss-explicit' }),
      );
    });

    it('routeUserChat runner 不存在时静默跳过（不抛错）', async () => {
      const mockRunner = { executeTask: vi.fn() };
      const runners = new Map<string, typeof mockRunner>();
      const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });

      await expect(
        svc.routeUserChat({ sessionId: '!room:home', assignmentId: 'ghost', body: 'hi' }),
      ).resolves.toBeUndefined();
      expect(mockRunner.executeTask).not.toHaveBeenCalled();
    });
  });

  describe('routeEvent（按 Matrix event 类型分流）', () => {
    it('m.room.message → 路由到目标 agent → executeTask', async () => {
      const mockRunner = { executeTask: vi.fn().mockResolvedValue({ streamSessionId: 'ss-1' }) };
      const runners = new Map([['inst1', mockRunner]]);
      const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });

      await svc.routeEvent(
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

      await svc.routeEvent(
        mkMockEvent('io.momo-studio.dispatch', {
          body: '写登录页',
          task_id: 'task-123',
          // v2（Task 10）：dispatch_from / dispatch_to 的值是 assignmentId（本地身份路由键）
          dispatch_from: 'inst-pm',
          dispatch_to: 'inst-sub',
        }),
        'inst-pm',
        '!room:home',
        'inst-sub',
      );

      expect(mockRunner.executeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-123',
          dispatchContext: expect.objectContaining({ fromAssignmentId: 'inst-pm' }),
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

      await svc.routeEvent(
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

    it('dispatch 未传 directTargetAssignmentId 时 dispatch_to（assignmentId）直接定位 runner', async () => {
      const mockRunner = { executeTask: vi.fn().mockResolvedValue({ streamSessionId: 'ss-3' }) };
      const runners = new Map([['inst-sub', mockRunner]]);
      const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });

      await svc.routeEvent(
        mkMockEvent('io.momo-studio.dispatch', {
          body: '写测试',
          task_id: 'task-456',
          dispatch_from: 'inst-pm',
          dispatch_to: 'inst-sub',
        }),
        'inst-pm',
        null,
      );

      // dispatch_to 值即 runners key——无需反查，直接派发
      expect(mockRunner.executeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-456',
          dispatchContext: expect.objectContaining({ fromAssignmentId: 'inst-pm' }),
        }),
      );
    });

    it('dispatch 自解析失败（dispatch_to 不是已知 assignmentId）时不派发', async () => {
      const mockRunner = { executeTask: vi.fn() };
      const runners = new Map([['inst-sub', mockRunner]]);
      const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });

      await svc.routeEvent(
        mkMockEvent('io.momo-studio.dispatch', {
          body: '写测试',
          task_id: 'task-789',
          dispatch_from: 'inst-pm',
          dispatch_to: 'inst-unknown',
        }),
        'inst-pm',
        null,
      );

      expect(mockRunner.executeTask).not.toHaveBeenCalled();
    });

    it('task_reply 带 reply_to（assignmentId）时精确路由到目标 PM（不广播）', async () => {
      const pmRunner = { executeTask: vi.fn(), notifyTaskReply: vi.fn() };
      const otherRunner = { executeTask: vi.fn(), notifyTaskReply: vi.fn() };
      const runners = new Map([
        ['inst-pm', pmRunner],
        ['inst-other', otherRunner],
      ]);
      const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });

      await svc.routeEvent(
        mkMockEvent('io.momo-studio.task_reply', {
          body: '完成',
          task_id: 'task-123',
          status: 'completed',
          reply_to: 'inst-pm',
        }),
        'inst-sub',
        '!room:home',
      );

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

      await svc.routeEvent(
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

  describe('routeAbortDispatch（abort_dispatch 级联传播）', () => {
    it('abort_dispatch → 广播 abortStream 到全部 runner（以 sub_stream_session_id 精确中断）', async () => {
      // 广播语义与 notifyTaskReply 一致：各 runner 的 activeTasks 活跃表自然过滤，
      // 只有持有该子流的 runner 真正下发 abort IPC——此处验证"全部收到广播"。
      const r1 = { executeTask: vi.fn(), notifyTaskReply: vi.fn(), abortStream: vi.fn() };
      const r2 = { executeTask: vi.fn(), notifyTaskReply: vi.fn(), abortStream: vi.fn() };
      const runners = new Map([
        ['inst-pm', r1],
        ['inst-sub', r2],
      ]);
      const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });

      await svc.routeEvent(
        mkMockEvent('io.momo-studio.abort_dispatch', {
          task_id: 'task-123',
          sub_stream_session_id: 'sub-sess-abc',
        }),
        'inst-pm',
        '!room:home',
      );

      expect(r1.abortStream).toHaveBeenCalledTimes(1);
      expect(r1.abortStream).toHaveBeenCalledWith('sub-sess-abc');
      expect(r2.abortStream).toHaveBeenCalledTimes(1);
      expect(r2.abortStream).toHaveBeenCalledWith('sub-sess-abc');
      // 级联中断不应触发任何新 task 派发
      expect(r1.executeTask).not.toHaveBeenCalled();
      expect(r2.executeTask).not.toHaveBeenCalled();
    });

    it('abort_dispatch 缺 sub_stream_session_id → 不调任何 runner 的 abortStream', async () => {
      const r1 = { executeTask: vi.fn(), notifyTaskReply: vi.fn(), abortStream: vi.fn() };
      const r2 = { executeTask: vi.fn(), notifyTaskReply: vi.fn(), abortStream: vi.fn() };
      const runners = new Map([
        ['inst-1', r1],
        ['inst-2', r2],
      ]);
      const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });

      await svc.routeEvent(
        mkMockEvent('io.momo-studio.abort_dispatch', {
          task_id: 'task-456',
        }),
        'inst-pm',
        '!room:home',
      );

      expect(r1.abortStream).not.toHaveBeenCalled();
      expect(r2.abortStream).not.toHaveBeenCalled();
    });

    it('abort_dispatch 无 runner 时 no-op 不抛错（目标不存在仅 warn）', async () => {
      const runners = new Map<string, { abortStream: () => void }>();
      const svc = new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });

      await expect(
        svc.routeEvent(
          mkMockEvent('io.momo-studio.abort_dispatch', {
            task_id: 'task-789',
            sub_stream_session_id: 'sub-sess-gone',
          }),
          'inst-pm',
          '!room:home',
        ),
      ).resolves.toBeUndefined();
    });
  });
});
