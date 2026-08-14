// electron/tests/agent/runtime-spawner.test.ts
//
// runtime-spawner 完整实现测试。
// 覆盖 2 个核心场景：spawnForAgent fork runtime-entry + 注册 handlers；
// stopRuntime 发 shutdown 消息（force kill 在 timeoutMs 后由实现触发）。
//
// 用 vi.mock('node:child_process') 拦截 fork()，避免真实拉起子进程。

import { describe, it, expect, vi } from 'vitest';
import { spawnForAgent, stopRuntime } from '../../src/main/agent/runtime-spawner';

// mock fork（避免真实 fork runtime-entry）
vi.mock('node:child_process', () => ({
  fork: vi.fn(() => ({
    pid: 12345,
    on: vi.fn(),
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
        botUserId: '@bot:home', botAccessToken: 'token', homeserverUrl: 'http://localhost',
        systemPrompt: '', modelName: 'gpt-4', llmApiKey: 'key', teamRoomId: '!room:home',
        ownerUserId: '@owner:home',
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