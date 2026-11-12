// electron/tests/agent/runtime-spawner.test.ts
//
// runtime-spawner 完整实现测试。
// 覆盖 2 个核心场景：spawnForAgent fork runtime-entry + 注册 handlers；
// stopRuntime 发 shutdown 消息（force kill 在 timeoutMs 后由实现触发）。
//
// 用 vi.mock('node:child_process') 拦截 fork()，避免真实拉起子进程。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { spawnForAgent, stopRuntime } from '../../src/main/agent/runtime-spawner';
import { __setSandboxStateForTest } from '../../src/main/sandbox/probe';

// fork mock 捕获槽：message handler 与 child.send——确认门接线用例直接驱动
const captured = vi.hoisted(() => ({
  handler: null as ((msg: unknown) => void) | null,
  send: null as ReturnType<typeof vi.fn> | null,
}));

// mock fork（避免真实 fork runtime-entry）。P0 boot 握手契约：真实子进程在
// 注册完监听器后异步发一次性 {type:'runtime-ready'}——mock 以 setImmediate
// 仿真该时序（消息监听器注册后、测试 await 恢复前到达）。
// Task 8 起 resource-ops 静态图引入 marketplace/installer（顶层 promisify(execFile)），
// mock 须保 execFile 等真实导出可达——importOriginal 部分化，仅 fork 拦截
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fork: vi.fn(() => {
    const send = vi.fn();
    captured.send = send;
    return {
      pid: 12345,
      on: vi.fn((event: string, cb: (msg: unknown) => void) => {
        if (event === 'message') {
          setImmediate(() => cb({ type: 'runtime-ready' }));
          captured.handler = cb;
        }
      }),
      off: vi.fn(),
      send,
      kill: vi.fn(),
    listeners: vi.fn(() => []),
      connected: true,
      once: vi.fn(),
    };
  }),
}));

// 2026-11-11 文件 IO 设置起 spawnForAgent 读 global_settings（kv_store）——
// 沿 resource-ops.test.ts 夹具：临时目录 + 全量迁移
const tmpRoot = path.join(os.tmpdir(), `ap-spawner-${Date.now()}`);
beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});
afterEach(() => {
  closeDb();
  delete process.env.AP_USER_DATA_DIR;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

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

  it('resource-op 确认门接线：后台流 fail-closed；end 清流后前台走确认通道（spec §7.3）', async () => {
    await spawnForAgent({
      assignmentId: 'inst-gate',
      runtimeConfig: {
        instanceId: 'inst-gate', workspaceId: 'ws-gate', workspaceDir: '/tmp',
        agentAssignmentId: 'inst-gate', agentUserId: 'agent-gate-1',
        systemPrompt: '', modelName: 'gpt-4', llmApiKey: 'key',
      } as never,
      onChunk: vi.fn(),
      onExit: vi.fn(),
    });
    const handler = captured.handler!;
    const send = captured.send!;
    send.mockClear();

    // 后台流：start chunk 携带 parentStreamSessionId（dispatch 子链标识）→
    // 需确认 op 立即拒绝，不触碰确认通道
    handler({ type: 'start', streamSessionId: 's-bg', sessionId: 'sess-1', senderAgentId: 'agent-gate-1', parentStreamSessionId: 'pm-1' });
    handler({ type: 'resource-op', id: 'q1', op: 'updateProfile', args: {} });
    await new Promise((r) => setImmediate(r));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource-op', id: 'q1', error: expect.stringContaining('后台'),
    }));

    // end 清流 → 同一 child 的下一个请求按前台处理：走确认通道
    //（测试环境无 BrowserWindow 窗口 → 确认通道按「无人在场」拒绝收敛）
    send.mockClear();
    handler({ type: 'end', streamSessionId: 's-bg', finishReason: 'stop' });
    handler({ type: 'resource-op', id: 'q2', op: 'updateProfile', args: {} });
    await new Promise((r) => setImmediate(r));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource-op', id: 'q2', error: expect.stringContaining('拒绝了本次变更'),
    }));
  });
});