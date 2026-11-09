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

// 「工具定义定型那一刻的探测态」观测点（终审必修 1 的时序锁）。
// getAllToolDefs → 各模块 getDefs() → ShellTools 在此读 getSandboxState() 定稿
// bash 描述。记录调用瞬间的状态：探测若改到 buildRuntimeContext 之后，这里读到
// 的必然是 null（runtime 子进程 cached 初值 null），用例即红。
const observed = vi.hoisted(() => ({
  probed: [] as boolean[],
  shell: [] as Array<string | null>,
}));

vi.mock('../../src/main/agent/tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/tools')>();
  const probe = await import('../../src/main/sandbox/probe');
  return {
    ...actual,
    getAllToolDefs: (modules: Parameters<typeof actual.getAllToolDefs>[0]) => {
      const state = probe.getSandboxState();
      observed.probed.push(state !== null);
      observed.shell.push(state?.windowsShell ?? null);
      return actual.getAllToolDefs(modules);
    },
  };
});

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import {
  runTaskChatLoop,
  bootRuntimeContext,
  __resetSandboxProbeForTest,
  type RuntimeContext,
} from '../../src/main/agent/runtime-entry';
import type { TaskConfig, RuntimeConfig } from '../../src/main/agent/runtime-config';
import { buildToolRegistry } from '../../src/main/agent/tools';
import { ShellTools } from '../../src/main/agent/tools/shell-tools';
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
  let exitSpy: MockInstance<typeof process.exit>;
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

  // ============================================================================
  // 终审必修 1：探测必须前移到 buildRuntimeContext **之前**。
  //
  // 根因：ShellTools.getDefs() 在被调用的一瞬间用 getSandboxState()?.windowsShell
  // 定稿 bash 描述；runtime 子进程的 cached 初值恒 null。探测若晚于 buildRuntimeContext，
  // pwsh.exe / powershell.exe 两支永远进不去 → 模型恒拿到「未探测 → 回退 5.1」文案，
  // 而执行侧 resolveShellSpawn 已有值且优先 pwsh.exe（装 PS7 的机器上命令与描述矛盾）。
  //
  // 锁法（顺序无法直接断言，用「定型时刻的快照」间接表达）：mock tools 模块包一层
  // getAllToolDefs，记录调用瞬间 getSandboxState() 是否为 null。红绿验证——把
  // bootRuntimeContext 里的 ensureSandboxProbed() 挪到 buildRuntimeContext 之后，
  // 本用例必红（记录到 null）。
  // ============================================================================
  it('bootRuntimeContext：工具定义定型时探测态已就绪（探测晚于 buildRuntimeContext 即红）', async () => {
    expect(getSandboxState()).toBeNull(); // 前置：boot 前为空
    observed.probed.length = 0;
    observed.shell.length = 0;

    const ctx2 = await bootRuntimeContext(makeConfig({ workspaceDir: tmpDir }));

    expect(vi.mocked(reprobeSandbox).mock.calls.length).toBe(1);
    // buildRuntimeContext 内会调两次 getAllToolDefs（defs 列表 + 白名单并集）
    expect(observed.probed.length).toBeGreaterThan(0);
    expect(observed.probed.every(Boolean)).toBe(true);
    expect(getSandboxState()).not.toBeNull();
    expect(ctx2.tools.some((t) => t.name === 'bash')).toBe(true);
  });

  // 2026-11-09 Windows 性能回归锁：主进程下发探测快照 → 子进程零 spawn。
  //
  // 症状：Win11 + 安全软件环境从 Electron 进程冷启动 pwsh.exe 实测 5.4s（第二次
  // 3.7s），每个 runtime 子进程 boot 都在自己的 reprobeSandbox 里白等 ~9-11s；
  // WarmPool K=2 ⇒ 加入工作空间 / 重启 agent 20s+。
  // 锁法：传入 sandboxProbe 后 bootRuntimeContext 不得调用 reprobeSandbox，
  // 且本地单例（bash 描述 / resolveShellSpawn 的消费源）必须是主进程结果。
  it('sandboxProbe 快照：子进程零探测，探测态直接取主进程结果（win32）', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      __resetSandboxProbeForTest();
      __setSandboxStateForTest(null);
      vi.mocked(reprobeSandbox).mockClear();
      observed.probed.length = 0;

      const ctx2 = await bootRuntimeContext(
        makeConfig({
          workspaceDir: tmpDir,
          sandboxProbe: { windowsShell: 'pwsh.exe', executionPolicy: 'RemoteSigned' },
        }),
      );

      expect(vi.mocked(reprobeSandbox)).not.toHaveBeenCalled();
      expect(getSandboxState()?.windowsShell).toBe('pwsh.exe');
      expect(getSandboxState()?.executionPolicy).toBe('RemoteSigned');
      // 工具定义定型时读到的是快照（非 null）
      expect(observed.probed.length).toBeGreaterThan(0);
      expect(observed.probed.every(Boolean)).toBe(true);
      expect(ctx2.tools.some((t) => t.name === 'bash')).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', original);
      __setSandboxStateForTest(null);
    }
  });

  // 探测已就绪且实测 shell = pwsh.exe 时，getDefs 的 bash 描述必须带 pwsh 事实。
  // win32 门控：描述按 process.platform 分平台（不 mock process.platform），posix
  // 上 shellToolDescription 根本不看 detectedShell——这一支只能在 win32 上验。
  // win32 文案本身由 tests/agent/tools/shell-tool-description.test.ts 三平台无关地锁住。
  it.skipIf(process.platform !== 'win32')('探测态 windowsShell=pwsh.exe 时 bash 描述含 pwsh 事实（支持 &&）', () => {
    __setSandboxStateForTest({
      platform: 'win32',
      sandboxTool: null,
      toolVersion: null,
      available: false,
      unavailableReason: null,
      windowsShell: 'pwsh.exe',
      executionPolicy: null,
      probedAt: Date.now(),
    });
    const bash = new ShellTools().getDefs().find((d) => d.name === 'bash');
    expect(bash?.description).toContain('PowerShell 7（pwsh.exe）');
    expect(bash?.description).toContain('支持 &&');
    expect(bash?.description).not.toContain('不支持');
  });
});
