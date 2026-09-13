// electron/tests/agent/runtime-sandbox-probe-wiring.test.ts
//
// 主机验收 P0 回归锁：runtime 子进程自探测接线（2026-09-13 macOS 主机首测暴露）。
//
// 根因链：reprobeSandbox 只在主进程 boot（index.ts）调用，而 bash 工具的
//   resolveShellSpawn 在 runtime 子进程执行——模块级单例 cached 按进程隔离，
//   子进程 getSandboxState() 恒 null → darwin/linux 分支不匹配 → strict 误拦，
//   报「OS 沙箱不可用（沙箱未探测）」且文案只有 Linux 安装指引。
//   「等某事件的代码必须先验证该事件有生产者」——生产者在另一个进程里。
//
// 为什么测试全绿但主机崩：v2.4 沙箱测试全部 in-process（__setSandboxStateForTest
//   注入或本进程 reprobe），无「子进程消费侧」契约测试。本锁与
//   journal-production-ctx.test.ts 同形态：真实 runTaskChatLoop 生产路径驱动，
//   只 mock 进程/网络边界。
//
// 形态：vi.mock sandbox/probe 包装真实实现（spy 记录 + 透传真实探测）——
//   既有接线断言（被调用/单飞），又有语义断言（本进程 getSandboxState 被填充）。
//   红绿验证：摘掉 runTaskChatLoop 内 ensureSandboxProbed 调用 → 用例 1/2 红。

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { StreamDelta } from '../../src/main/agent/llm-provider';

// 必须在 import runtime-entry 之前 mock（vi.mock hoist）——llm-provider 是网络边界
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

// spy 包装真实 reprobeSandbox：接线断言 + 真实语义两不误
vi.mock('../../src/main/sandbox/probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/sandbox/probe')>();
  return { ...actual, reprobeSandbox: vi.fn(actual.reprobeSandbox) };
});

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import { runTaskChatLoop, __resetSandboxProbeForTest, type RuntimeContext } from '../../src/main/agent/runtime-entry';
import type { TaskConfig, RuntimeConfig } from '../../src/main/agent/runtime-config';
import { buildToolRegistry } from '../../src/main/agent/tools';
import { reprobeSandbox, __setSandboxStateForTest, getSandboxState } from '../../src/main/sandbox/probe';
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
    workspaceId: 'ws-sb',
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
    workspaceId: 'ws-sb',
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
    workspaceId: 'ws-sb',
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
    body: '探测接线测试',
    streamSessionId: 'ssn-1',
  };
}

/** 单轮纯文本（探测断言不依赖工具执行） */
function mockSingleTextRound(): void {
  vi.mocked(createLLMProvider).mockReturnValue({
    chat: vi.fn(),
    chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
      yield { type: 'text', content: '完成' };
      yield { type: 'done', finishReason: 'stop' };
    }),
  });
}

describe('runtime 子进程沙箱探测接线锁（主机验收 P0 修复）', () => {
  const udRoot = path.join(os.tmpdir(), `momo-sbprobe-ud-${Date.now()}`);
  let tmpDir: string;
  let exitSpy: MockInstance<Parameters<typeof process.exit>, ReturnType<typeof process.exit>>;
  const originalSend = process.send;
  const sentChunks: unknown[] = [];

  beforeEach(() => {
    fs.mkdirSync(udRoot, { recursive: true });
    process.env.AP_USER_DATA_DIR = udRoot;
    runMigrations();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-sbprobe-ws-'));
    sentChunks.length = 0;
    vi.mocked(reprobeSandbox).mockClear();
    __resetSandboxProbeForTest();
    __setSandboxStateForTest(null);
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
    __setSandboxStateForTest(null);
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(udRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('runTaskChatLoop 启动时调用 reprobeSandbox（生产者与消费者同进程）', async () => {
    await runTaskChatLoop(makeTaskConfig(), makeConfig({ workspaceDir: tmpDir }), makeBootCtx(tmpDir));

    expect(reprobeSandbox).toHaveBeenCalled();
    // 任务链路完整走完（不是早期抛错导致的「看似没调用」）
    expect(sentChunks.some((c) => (c as { type?: string }).type === 'task-end')).toBe(true);
  });

  it('本进程 getSandboxState 被真实填充（语义断言：bash 消费侧不再恒 null）', async () => {
    expect(getSandboxState()).toBeNull(); // 前置：boot 前确实为空

    await runTaskChatLoop(makeTaskConfig(), makeConfig({ workspaceDir: tmpDir }), makeBootCtx(tmpDir));

    const state = getSandboxState();
    expect(state).not.toBeNull();
    expect(state?.probedAt).toBeGreaterThan(0);
  });

  it('单飞：同进程多次任务只探测一次', async () => {
    const cfg2 = { ...makeTaskConfig(), streamSessionId: 'ssn-2', taskId: 'T-2' };
    await runTaskChatLoop(makeTaskConfig(), makeConfig({ workspaceDir: tmpDir }), makeBootCtx(tmpDir));
    await runTaskChatLoop(cfg2, makeConfig({ workspaceDir: tmpDir }), makeBootCtx(tmpDir));

    expect(vi.mocked(reprobeSandbox).mock.calls.length).toBe(1);
    expect(getSandboxState()).not.toBeNull();
  });
});
