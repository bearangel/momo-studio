// electron/tests/agent/runtime-spawner.test.ts
//
// runtime-spawner 完整实现测试。
// 覆盖 2 个核心场景：spawnForAgent fork runtime-entry + 注册 handlers；
// stopRuntime 发 shutdown 消息（force kill 在 timeoutMs 后由实现触发）。
//
// 用 vi.mock('node:child_process') 拦截 fork()，避免真实拉起子进程。

import { describe, it, expect, vi } from 'vitest';
import { spawnForAgent, stopRuntime } from '../../src/main/agent/runtime-spawner';

// mock fork（避免真实 fork runtime-entry）。P0 boot 握手契约：真实子进程在
// 注册完监听器后异步发一次性 {type:'runtime-ready'}——mock 以 setImmediate
// 仿真该时序（消息监听器注册后、测试 await 恢复前到达）。
vi.mock('node:child_process', () => ({
  fork: vi.fn(() => ({
    pid: 12345,
    on: vi.fn((event: string, cb: (msg: unknown) => void) => {
      if (event === 'message') {
        setImmediate(() => cb({ type: 'runtime-ready' }));
      }
    }),
    off: vi.fn(),
    send: vi.fn(),
    kill: vi.fn(),
    connected: true,
    once: vi.fn(),
  })),
}));

describe('runtime-spawner', () => {
  it('spawnForAgent fork runtime-entry + 注册 handlers', async () => {
    const opts = {
      assignmentId: 'inst1',
      runtimeConfig: {
        instanceId: 'inst1', workspaceId: 'ws1', workspaceDir: '/tmp',
        agentAssignmentId: 'inst1', agentUserId: 'agent-bot-x1', teamSessionId: 'sess-team',
        systemPrompt: '', modelName: 'gpt-4', llmApiKey: 'key',
      } as never,
      onChunk: vi.fn(),
      onExit: vi.fn(),
    };
    const runtime = await spawnForAgent(opts);
    expect(runtime.child.pid).toBe(12345);
    expect(runtime.assignmentId).toBe('inst1');
    expect(runtime.child.on).toHaveBeenCalled();
  });

  it('stopRuntime 发 shutdown + 等 + force kill', async () => {
    const { fork } = await import('node:child_process');
    const mockChild = (fork as ReturnType<typeof vi.fn>).mock.results[0]?.value ?? {
      send: vi.fn(), kill: vi.fn(), on: vi.fn(), connected: true,
    };
    await stopRuntime(mockChild as never, { timeoutMs: 100 });
    expect(mockChild.send).toHaveBeenCalledWith({ type: 'shutdown' });
  });
});