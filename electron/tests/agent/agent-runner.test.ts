// electron/tests/agent/agent-runner.test.ts
//
// AgentRunner（task-driven 核心重构）测试。
// 覆盖 4 个核心场景：
//   1. executeTask 从 warm pool 取 runtime，注入 task config
//   2. task 结束（end chunk）→ release runtime + activeTaskCount 减 1
//   3. abortStream 中断指定 task
//   4. destroy 释放所有活跃 runtime + warm pool
// ChildProcess 用 mock（与 warm-pool.test.ts 同模式，避免真实 fork）。

import { describe, it, expect, vi } from 'vitest';
import { AgentRunner } from '../../src/main/agent/agent-runner';
import { WarmPool } from '../../src/main/agent/warm-pool';
import type { ChildProcess } from 'node:child_process';

/**
 * 构造 mock 子进程——记录 message handler 以便测试模拟子进程发 chunk。
 * send() 收到 task-config 后异步回 task-ack（模拟真实子进程握手）。
 */
function mkMockChild(): ChildProcess {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    pid: 12345,
    on: vi.fn((event: string, h: (...args: unknown[]) => void) => {
      handlers[event] = h;
    }),
    off: vi.fn(),
    send: vi.fn((msg: unknown) => {
      // 模拟子进程收到 task-config 后立即返回 ack
      if (
        typeof msg === 'object' &&
        msg !== null &&
        (msg as { type?: string }).type === 'task-config'
      ) {
        setTimeout(
          () =>
            handlers['message']?.({
              type: 'task-ack',
              streamSessionId: (msg as { streamSessionId: string }).streamSessionId,
            }),
          0,
        );
      }
      return true;
    }),
    kill: vi.fn(),
    connected: true,
  } as unknown as ChildProcess;
}

describe('AgentRunner', () => {
  it('executeTask 从 warm pool 取 runtime，注入 task config', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('agent-1');

    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-x1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });

    const result = await runner.executeTask({
      taskId: null,
      executionSessionId: '!room:home',
      body: 'hi',
      streamSessionId: 'ss-1',
    });
    expect(result.streamSessionId).toBe('ss-1');
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task-config',
        streamSessionId: 'ss-1',
        body: 'hi',
      }),
    );
    expect(runner.activeTaskCount()).toBe(1);
  });

  it('task 结束（end chunk）→ release runtime + activeTaskCount 减 1', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('agent-1');

    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-x1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });

    await runner.executeTask({
      taskId: null,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-1',
    });
    // 模拟子进程发 end chunk——从 mock.calls 中取回注册的 message handler
    const onCalls = (child.on as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const msgHandler = onCalls.find((c) => c[0] === 'message')?.[1] as
      | ((msg: unknown) => void)
      | undefined;
    msgHandler?.({ type: 'end', streamSessionId: 'ss-1', finishReason: 'stop' });
    expect(runner.activeTaskCount()).toBe(0);
  });

  it('abortStream 中断指定 task', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('agent-1');

    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-x1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });

    await runner.executeTask({
      taskId: null,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-1',
    });
    runner.abortStream('ss-1');
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'abort', streamSessionId: 'ss-1' }),
    );
  });

  it('destroy 释放所有活跃 runtime + warm pool', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('agent-1');

    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-x1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });
    await runner.executeTask({
      taskId: null,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-1',
    });
    runner.destroy();
    // destroy → release → child.kill（与 warm-pool.test.ts 同断言模式）
    expect(child.kill).toHaveBeenCalled();
  });
});
