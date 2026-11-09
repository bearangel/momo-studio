// electron/tests/agent/runtime-spawner.test.ts
//
// runtime-spawner 完整实现测试。
// 覆盖 2 个核心场景：spawnForAgent fork runtime-entry + 注册 handlers；
// stopRuntime 发 shutdown 消息（force kill 在 timeoutMs 后由实现触发）。
//
// 用 vi.mock('node:child_process') 拦截 fork()，避免真实拉起子进程。

import { describe, it, expect, vi } from 'vitest';
import { spawnForAgent, stopRuntime } from '../../src/main/agent/runtime-spawner';
import { __setSandboxStateForTest } from '../../src/main/sandbox/probe';

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

// 沙箱探测快照：win32 spawn 时把主进程缓存结果塞进 AGENT_CONFIG（子进程零 spawn）。
// 用真实 probe 的测试钩子注入，不 mock 模块——保持「快照 = 主进程探测产物」语义。

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

  it('win32：沙箱探测快照随 AGENT_CONFIG 下传（子进程零 PowerShell spawn）', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    __setSandboxStateForTest({
      platform: 'win32',
      sandboxTool: null,
      toolVersion: null,
      available: false,
      unavailableReason: null,
      windowsShell: 'pwsh.exe',
      executionPolicy: 'RemoteSigned',
      probedAt: Date.now(),
    });
    try {
      const { fork } = await import('node:child_process');
      vi.mocked(fork).mockClear();
      await spawnForAgent({
        assignmentId: 'inst-win',
        runtimeConfig: { instanceId: 'inst-win', workspaceId: 'ws1', workspaceDir: 'C:/tmp' } as never,
        onChunk: vi.fn(),
        onExit: vi.fn(),
      });
      const call = vi.mocked(fork).mock.calls.at(-1)!;
      const env = (call[2] as { env: NodeJS.ProcessEnv }).env;
      const cfg = JSON.parse(env.AGENT_CONFIG ?? '{}') as { sandboxProbe?: unknown };
      expect(cfg.sandboxProbe).toEqual({
        windowsShell: 'pwsh.exe',
        executionPolicy: 'RemoteSigned',
      });
    } finally {
      Object.defineProperty(process, 'platform', original);
      __setSandboxStateForTest(null);
    }
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