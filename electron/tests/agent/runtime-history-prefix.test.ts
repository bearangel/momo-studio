// electron/tests/agent/runtime-history-prefix.test.ts
//
// v2.8.0 Orchestration 元语 Task 2：runChatLoop historyPrefix 参数
// （payload 字段 + 拼接分支——followup 续聊的上下文前缀）。
//
// 测试模式：照 runtime-resume.test.ts 的直调骨架（fake LLM 确定流捕获首轮
// 请求 messages）+ 末尾一条 runTaskChatLoop 接线锁（runtime-task-driven.test.ts
// 的 v2.6.0 接线锁纪律——payload 字段静默丢失不报错，必须专项锁死）。
//
// 断言清单（task brief Step 1）：
//   1. historyPrefix 存在 + 无 resumeTurn → 前缀拼接在 convMessages 之前、
//      currentBody 照常追加（fresh session 形态 [system, ...前缀, user(body)]）
//   2. historyPrefix + resumeTurn 同现 → resumeTurn 语义胜出（前缀忽略，
//      请求 messages 不含前缀）+ warn 日志 + 不抛错
//   3. 无 historyPrefix → 行为与既有逐字节一致（system + user(currentBody)）
//
// 边界补充（momo-test-rules 铁律 3——空输入专项）：
//   - historyPrefix=[]（空数组）→ 等价无前缀（请求形状与既有逐字节一致）
//
// 契约锁（momo-test-rules 铁律 4）：TaskConfig.historyPrefix（payload 字段）经
// runTaskChatLoop 解构透传到 runChatLoop 第 11 参——摘掉解构/传参该锁必红
// （前缀静默丢失不报错，Task 6 followup 派发侧依赖此环）。

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LLMMessage, StreamDelta } from '../../src/main/agent/llm-provider';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';
import { closeDb } from '../../src/main/storage/db';
import { type RebuiltTurn } from '../../src/main/agent/turn-reconstructor';

// 必须在 import runtime-entry 之前 mock llm-provider（vi.mock 会被 hoist）
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import {
  runChatLoop,
  runTaskChatLoop,
  type RuntimeContext,
} from '../../src/main/agent/runtime-entry';
import type { RuntimeConfig, TaskConfig } from '../../src/main/agent/runtime-config';
import { buildToolRegistry } from '../../src/main/agent/tools';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
  type ContextMessage,
} from '../../src/main/memory';

// === 夹具（沿用 runtime-resume.test.ts 模式）===

const sentChunks: unknown[] = [];

// runChatLoop 会话边界过滤每轮触 DB——文件级兜底（runtime-task-driven.test.ts
// 同款）：未显式设 AP_USER_DATA_DIR 时指向临时目录，防惰性 getDb 落到默认用户
// 目录缓存句柄污染后续 describe；每用例后 closeDb 防句柄泄漏
const fallbackTmp = path.join(
  os.tmpdir(),
  `ap-prefix-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
beforeEach(() => {
  if (!process.env.AP_USER_DATA_DIR) {
    fs.mkdirSync(fallbackTmp, { recursive: true });
    process.env.AP_USER_DATA_DIR = fallbackTmp;
  }
});
afterEach(() => {
  closeDb();
});
afterAll(() => {
  fs.rmSync(fallbackTmp, { recursive: true, force: true });
});

// convCtx 覆盖钩子（mockProviderOverride 模式）：默认空；用例可注入早前会话消息
let convOverride: ContextMessage[] | null = null;
const stubProvider: MemoryProvider = {
  getTaskContext: async () => null,
  getConversationContext: async () =>
    convOverride ? { messages: convOverride } : { messages: [] },
  getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
  getUserContext: async () => ({ preferences: [] }),
  getWorkspaceContext: async () => null,
  getPinnedContext: async () => ({ hint: '', truncatedCount: 0, pinnedIds: [] }),
  searchMemories: async () => { throw new Error('测试 stub 不落库'); },
  saveMemory: async () => { throw new Error('测试 stub 不落库'); },
  deleteMemory: async () => { throw new Error('测试 stub 不落库'); },
};

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-bot',
    agentUserId: '@bot:localhost',
    systemPrompt: 'You are a test bot.',
    modelName: 'test-model',
    llmApiKey: 'test-key',
    workspaceDir: '/tmp/test',
    workspaceId: 'ws-1',
    role: 'standalone',
    subAgents: [],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: false,
    devMode: false,
    maxToolCalls: 10,
    contextWindow: 0, // 0=未知 → auto 压缩 fail-safe 跳过（同既有测试的缺省行为）
    outputTokens: 0,
    ...overrides,
  };
}

function makeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  const mockWsFs = {
    readFile: vi.fn().mockResolvedValue(Buffer.from('mock')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    listDir: vi.fn().mockResolvedValue([]),
  } as unknown as WorkspaceFS;
  const mockSkillRegistry = {
    list: () => [],
    getIndex: () => '',
  } as unknown as RuntimeContext['skillRegistry'];
  return {
    wsFs: mockWsFs,
    skillRegistry: mockSkillRegistry,
    tools: [],
    systemPrompt: 'You are a helpful assistant.',
    workspaceId: 'ws-1',
    workspaceDir: '/tmp/test',
    roomId: '!room:localhost',
    streamSessionId: 'test-session',
    sendStreamChunk: () => {},
    creatorUserId: 'user-1',
    toolModules: buildToolRegistry({
      wsFs: mockWsFs,
      workspaceId: 'ws-1',
      workspaceDir: '/tmp/test',
      skillRegistry: mockSkillRegistry,
      streamSessionId: 'test-session',
      roomId: '!room:localhost',
      sendStreamChunk: () => {},
      creatorUserId: 'user-1',
      permissionConfig: { allowedTools: [], deniedTools: [] },
    }),
    ...overrides,
  };
}

function makeTaskConfig(overrides: Partial<TaskConfig> = {}): TaskConfig {
  return {
    type: 'task-config',
    taskId: null,
    executionSessionId: '!room:localhost',
    body: 'hi',
    streamSessionId: 'task-session-001',
    ...overrides,
  };
}

/** 单轮收尾的 fake LLM：捕获首轮请求 messages 后 text + stop */
function mockSingleRoundStop(capture: (msgs: LLMMessage[]) => void): void {
  vi.mocked(createLLMProvider).mockReturnValue({
    chat: vi.fn(),
    chatStream: vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
      capture([...messages]);
      yield { type: 'text', content: '已续聊' };
      yield { type: 'done', finishReason: 'stop' };
    }) as never,
  });
}

/** 从捕获数组取 system 消息正文 */
function systemContentOf(messages: LLMMessage[]): string {
  const sys = messages.find((m) => m.role === 'system');
  if (!sys) throw new Error('system 消息未找到');
  return sys.content;
}

/** followup 场景的典型前缀：先前回合的 user 指令 + assistant 产出 */
function samplePrefix(): LLMMessage[] {
  return [
    { role: 'user', content: '先前任务指令' },
    { role: 'assistant', content: '先前任务结果' },
  ];
}

describe('runChatLoop historyPrefix（followup 续聊前缀参数）', () => {
  const originalSend = process.send;

  beforeEach(() => {
    sentChunks.length = 0;
    convOverride = null;
    vi.mocked(createLLMProvider).mockReset();
    __setMemoryProviderForTest(stubProvider);
    process.send = ((msg: unknown): boolean => {
      sentChunks.push(msg);
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
  });

  it('historyPrefix + 无 resumeTurn → 前缀拼在 user 之前、currentBody 照常追加（fresh session 形态）', async () => {
    let first: LLMMessage[] = [];
    mockSingleRoundStop((m) => { first = m; });

    const stats = { toolCallsUsed: 0 };
    await runChatLoop(
      '!room:t', '接着上面的继续', makeConfig(), makeContext(),
      stats, undefined, undefined, 's-prefix-1', undefined, samplePrefix(),
    );

    // fresh session（conv 恒空）实际形态：[system, ...前缀, user(currentBody)]
    expect(first.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    // 前缀两条 verbatim 拼接
    expect(first[1]).toEqual({ role: 'user', content: '先前任务指令' });
    expect(first[2]).toEqual({ role: 'assistant', content: '先前任务结果' });
    // currentBody 照常作为本轮 user 消息（恰 1 条真实指令在后）
    expect(first[3]).toEqual({ role: 'user', content: '接着上面的继续' });
    // mandate 段取 currentBody（无 resumeTurn 时 userBody 语义不变）
    const sys = systemContentOf(first);
    expect(sys).toContain('「接着上面的继续」');
    expect(sys).not.toContain('先前任务指令');
  });

  it('convCtx 非空 → 前缀拼接在 convMessages 之前（早前会话历史仍在前缀之后）', async () => {
    convOverride = [
      { role: 'user', content: '早前问题', timestamp: 1000, sender: 'owner' },
      { role: 'assistant', content: '早前回答', timestamp: 1001, sender: 'bot' },
    ];
    let first: LLMMessage[] = [];
    mockSingleRoundStop((m) => { first = m; });

    await runChatLoop(
      '!room:t', '本轮新指令', makeConfig(), makeContext(),
      { toolCallsUsed: 0 }, undefined, undefined, 's-prefix-conv', undefined, samplePrefix(),
    );

    // 顺序铁律：system → 前缀 → conv 历史 → 本轮 user
    expect(first.map((m) => m.role)).toEqual([
      'system', 'user', 'assistant', 'user', 'assistant', 'user',
    ]);
    expect(first[1]).toEqual({ role: 'user', content: '先前任务指令' });
    expect(first[2]).toEqual({ role: 'assistant', content: '先前任务结果' });
    expect(first[3]).toEqual({ role: 'user', content: '早前问题' });
    expect(first[4]).toEqual({ role: 'assistant', content: '早前回答' });
    expect(first[5]).toEqual({ role: 'user', content: '本轮新指令' });
  });

  it('historyPrefix 与 resumeTurn 同现 → resumeTurn 语义胜出：前缀忽略（请求不含前缀）+ warn + 不抛错', async () => {
    let first: LLMMessage[] = [];
    mockSingleRoundStop((m) => { first = m; });

    const resumeTurn: RebuiltTurn = {
      messages: [{ role: 'user', content: '断点指令' }],
      toolCallsUsed: 0,
      steers: [],
      degenerate: false,
    };
    // spy 透传写（不吞输出）；用例内还原防影响后续用例
    const stderrSpy = vi.spyOn(process.stderr, 'write');

    await runChatLoop(
      '!room:t', '恢复兜底正文', makeConfig(), makeContext(),
      { toolCallsUsed: 0 }, undefined, undefined, 's-prefix-conflict', resumeTurn, samplePrefix(),
    );

    // resume 语义胜出：messages = system + 重建段（恰 resume 形状）
    expect(first.map((m) => m.role)).toEqual(['system', 'user']);
    expect(first[1]).toEqual({ role: 'user', content: '断点指令' });
    // 前缀彻底不进请求
    expect(first.some((m) => m.content === '先前任务指令')).toBe(false);
    expect(first.some((m) => m.content === '先前任务结果')).toBe(false);
    // warn 日志（runtime-entry 惯例 process.stderr.write）同时点名两参数
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('historyPrefix'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('resumeTurn'));
    stderrSpy.mockRestore();
  });

  it('无 historyPrefix → 请求形状与既有逐字节一致（system + user(currentBody)）', async () => {
    let first: LLMMessage[] = [];
    mockSingleRoundStop((m) => { first = m; });

    await runChatLoop(
      '!room:t', '普通消息', makeConfig(), makeContext(),
      { toolCallsUsed: 0 }, undefined, undefined, 's-prefix-none',
    );

    // 对照断言（现状形状）：conv 为空时恰 2 条——system + user(currentBody)
    expect(first).toHaveLength(2);
    expect(first[0]!.role).toBe('system');
    expect(first[0]!.content).not.toBe(''); // refreshSystem 已填充
    expect(first[1]).toEqual({ role: 'user', content: '普通消息' });
  });

  it('historyPrefix=[]（空数组边界）→ 等价无前缀，请求形状与既有逐字节一致', async () => {
    let first: LLMMessage[] = [];
    mockSingleRoundStop((m) => { first = m; });

    await runChatLoop(
      '!room:t', '空前缀消息', makeConfig(), makeContext(),
      { toolCallsUsed: 0 }, undefined, undefined, 's-prefix-empty', undefined, [],
    );

    expect(first).toHaveLength(2);
    expect(first[0]!.role).toBe('system');
    expect(first[1]).toEqual({ role: 'user', content: '空前缀消息' });
  });
});

describe('runTaskChatLoop historyPrefix 接线锁（payload 字段透传）', () => {
  const originalSend = process.send;

  beforeEach(() => {
    sentChunks.length = 0;
    convOverride = null;
    vi.mocked(createLLMProvider).mockReset();
    __setMemoryProviderForTest(stubProvider);
    // process.send 同时捕获 stream chunk 与 task-end IPC（callback 兼容 sendTaskEndAndExit）
    process.send = ((
      msg: unknown,
      callback?: (err: Error | null) => void,
    ): boolean => {
      sentChunks.push(msg);
      if (callback) callback(null);
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
  });

  it('cfg.historyPrefix 经 runTaskChatLoop 解构透传到 runChatLoop——首轮 LLM messages 含前缀 + currentBody 照常（摘掉解构/传参必红）', async () => {
    // 接线链（同 v2.6.0 resume 接线锁纪律）：Task 6 followup 派发侧 →
    // TaskConfig.historyPrefix（IPC）→ runTaskChatLoop 解构 → runChatLoop 第 11 参。
    // 直调用例锁参数消费语义，本用例锁「解构 + 透传」这一环——摘掉后前缀
    // 静默丢失（不报错），只有本用例变红。
    let first: LLMMessage[] = [];
    mockSingleRoundStop((m) => { first = m; });

    // mock process.exit：记录退出码但不真正退出（runTaskChatLoop 成功路径会调用）
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await runTaskChatLoop(
      makeTaskConfig({
        body: 'followup 正文',
        streamSessionId: 's-wiring-prefix-1',
        historyPrefix: samplePrefix(),
      }),
      makeConfig(),
      makeContext(),
    );

    // 前缀经 IPC 载荷透传进 LLM 请求：system + 前缀 2 条 + user(body)
    expect(first.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(first[1]).toEqual({ role: 'user', content: '先前任务指令' });
    expect(first[2]).toEqual({ role: 'assistant', content: '先前任务结果' });
    expect(first[3]).toEqual({ role: 'user', content: 'followup 正文' });
    exitSpy.mockRestore();
  });
});
