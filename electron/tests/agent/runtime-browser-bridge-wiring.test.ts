// electron/tests/agent/runtime-browser-bridge-wiring.test.ts
//
// 主机验收 P0 回归锁：runtime 子进程 browser 工具 IPC 桥接线。
//
// 根因链（与 runtime-sandbox-probe-wiring 同模式，同类缺陷第三例）：
//   initBrowserTools(policy, manager) 只在主进程 boot（browser/boot.ts T10）调用，
//   但 agent 工具在 runtime 子进程执行（BrowserManager 持 WebContentsView 只能
//   活在主进程）→ 子进程 browser-tools 模块态恒未初始化 → 12 个浏览器工具全部
//   报「BrowserTools 未初始化」。修复：runTaskChatLoop 启动时
//   ensureBrowserToolsBridged()（once-guard）注入 IPC 桥端口。
//
// 形态：真实 runTaskChatLoop 生产路径驱动，只 mock 进程/网络边界（llm-provider
//   网络边界 + initBrowserTools spy 包装真实实现）。红绿验证：摘掉
//   runTaskChatLoop 内 ensureBrowserToolsBridged 调用 → 用例 1/3 红。

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { StreamDelta } from '../../src/main/agent/llm-provider';

// 必须在 import runtime-entry 之前 mock（vi.mock hoist）——llm-provider 是网络边界
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

// spy 包装真实 initBrowserTools：接线断言（被调用/单飞/注入形状）+ 透传真实注入
vi.mock('../../src/main/agent/tools/browser-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/tools/browser-tools')>();
  return { ...actual, initBrowserTools: vi.fn(actual.initBrowserTools) };
});

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import {
  runTaskChatLoop,
  __resetSandboxProbeForTest,
  __resetBrowserBridgeForTest,
  type RuntimeContext,
} from '../../src/main/agent/runtime-entry';
import { initBrowserTools, __resetBrowserToolsForTest } from '../../src/main/agent/tools/browser-tools';
import type { TaskConfig, RuntimeConfig } from '../../src/main/agent/runtime-config';
import { buildToolRegistry } from '../../src/main/agent/tools';
import { WorkspaceFS } from '../../src/main/files/workspace-fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-bot',
    agentUserId: '@bot:localhost',
    systemPrompt: '',
    modelName: 'test',
    llmApiKey: 'k',
    workspaceDir: '',
    workspaceId: 'ws-br',
    role: 'standalone',
    subAgents: [],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: false,
    devMode: false,
    maxToolCalls: 10,
    contextWindow: 0,
    outputTokens: 0,
    ...overrides,
  };
}

function makeBootCtx(workspaceDir: string): RuntimeContext {
  const wsFs = new WorkspaceFS(workspaceDir);
  const skillRegistry = { list: () => [] } as never;
  const sendStreamChunk = (): void => {};
  const registryCtx = {
    wsFs,
    workspaceId: 'ws-br',
    workspaceDir,
    skillRegistry,
    streamSessionId: '',
    roomId: '',
    sendStreamChunk,
    permissionConfig: { allowedTools: [] as string[], deniedTools: [] as string[] },
    creatorUserId: 'test-user',
  };
  return {
    wsFs,
    skillRegistry,
    tools: [],
    systemPrompt: '',
    workspaceId: 'ws-br',
    workspaceDir,
    roomId: '',
    streamSessionId: '',
    sendStreamChunk,
    creatorUserId: 'test-user',
    toolModules: buildToolRegistry(registryCtx),
  };
}

function makeTaskConfig(): TaskConfig {
  return {
    type: 'task-config',
    taskId: 'T-1',
    executionSessionId: 'sess-1',
    body: '浏览器桥接线测试',
    streamSessionId: 'ssn-1',
  };
}

/** 单轮纯文本（接线断言不依赖工具执行） */
function mockSingleTextRound(): void {
  vi.mocked(createLLMProvider).mockReturnValue({
    chat: vi.fn(),
    chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
      yield { type: 'text', content: '完成' };
      yield { type: 'done', finishReason: 'stop' };
    }),
  });
}

describe('runtime 子进程 browser 桥接线锁（主机验收 P0 修复）', () => {
  const udRoot = path.join(os.tmpdir(), `momo-brbridge-ud-${Date.now()}`);
  let tmpDir: string;
  let exitSpy: MockInstance<Parameters<typeof process.exit>, ReturnType<typeof process.exit>>;
  const originalSend = process.send;
  const sentChunks: unknown[] = [];

  beforeEach(() => {
    fs.mkdirSync(udRoot, { recursive: true });
    process.env.AP_USER_DATA_DIR = udRoot;
    runMigrations();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-brbridge-ws-'));
    sentChunks.length = 0;
    vi.mocked(initBrowserTools).mockClear();
    __resetSandboxProbeForTest();
    __resetBrowserBridgeForTest();
    __resetBrowserToolsForTest();
    mockSingleTextRound();
    process.send = ((
      msg: unknown,
      callback?: (err: Error | null) => void,
    ): boolean => {
      sentChunks.push(msg);
      if (callback) callback(null);
      return true;
    }) as NonNullable<typeof process.send>;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    process.send = originalSend;
    exitSpy.mockRestore();
    __resetBrowserBridgeForTest();
    __resetBrowserToolsForTest();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(udRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('runTaskChatLoop 启动时注入 browser 桥端口（initBrowserTools 被调用）', async () => {
    await runTaskChatLoop(makeTaskConfig(), makeConfig({ workspaceDir: tmpDir }), makeBootCtx(tmpDir));

    expect(initBrowserTools).toHaveBeenCalledTimes(1);
    // 任务链路完整走完（不是早期抛错导致的「看似没调用」）
    expect(sentChunks.some((c) => (c as { type?: string }).type === 'task-end')).toBe(true);
  });

  it('注入形状：policy 两门 + manager 全部 12 方法均为可调用代理', async () => {
    await runTaskChatLoop(makeTaskConfig(), makeConfig({ workspaceDir: tmpDir }), makeBootCtx(tmpDir));

    const calls = vi.mocked(initBrowserTools).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [policy, manager] = calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(typeof policy['assertAllowed']).toBe('function');
    expect(typeof policy['assertEvaluate']).toBe('function');
    for (const m of [
      'navigate', 'snapshot', 'screenshot', 'click', 'type', 'pressKey',
      'hover', 'scroll', 'evaluate', 'consoleMessages', 'tabsAction', 'closeBrowser',
    ]) {
      expect(typeof manager[m], `manager.${m} 应为函数`).toBe('function');
    }
  });

  it('单飞：同进程多次任务只注入一次（once-guard）', async () => {
    const cfg2 = { ...makeTaskConfig(), streamSessionId: 'ssn-2', taskId: 'T-2' };
    await runTaskChatLoop(makeTaskConfig(), makeConfig({ workspaceDir: tmpDir }), makeBootCtx(tmpDir));
    await runTaskChatLoop(cfg2, makeConfig({ workspaceDir: tmpDir }), makeBootCtx(tmpDir));

    expect(vi.mocked(initBrowserTools).mock.calls.length).toBe(1);
  });
});
