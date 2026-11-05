// electron/tests/agent/runtime-usage-aggregation.test.ts
//
// R3 真实 token 遥测——runtime 侧聚合与 IPC 传播契约锁（2026-11-05）：
//   1. runChatLoop：跨轮（含工具轮）累积 done delta 的 usage → stats.usageTotal
//      （整数直加，provider 未报文的轮次贡献 0）
//   2. 全程无 usage → stats.usageTotal undefined（下游保持 actual_tokens NULL）
//   3. runTaskChatLoop 成功路径：task-end IPC 携带 usageTotal（camelCase，
//      与 toolCallsUsed 同型）；dispatch 任务另发 task_reply 携带
//      usage_total（snake_case 线协议，与 tool_calls_used 同型）
//   4. 错误路径：task-end(error) 同样携带 usageTotal（失败回合的消耗也是真实数据）
//
// mock 收窄（momo-test-rules）：只 mock LLM provider；工具链用真实
// buildToolRegistry（read_file 走 mock wsFs）。process.send / process.exit
// 打桩沿 runtime-task-driven.test.ts 同款（callback 形式兼容 sendTaskEndAndExit）。
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { StreamDelta } from '../../src/main/agent/llm-provider';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';

vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import {
  runChatLoop,
  runTaskChatLoop,
  type RuntimeContext,
  type RunChatLoopStats,
} from '../../src/main/agent/runtime-entry';
import type { RuntimeConfig, TaskConfig } from '../../src/main/agent/runtime-config';
import { buildToolRegistry } from '../../src/main/agent/tools';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

const ROOM = '!room:usage-aggr';
const sentIpc: unknown[] = [];
let exitCode: number | null = null;

const stubMemoryProvider: MemoryProvider = {
  getTaskContext: async () => null,
  getConversationContext: async () => ({ messages: [] }),
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
    contextWindow: 0,
    outputTokens: 0,
    subAgents: [],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: false,
    devMode: false,
    maxToolCalls: 10,
    ...overrides,
  };
}

function makeContext(): RuntimeContext {
  const mockWsFs = {
    readFile: vi.fn().mockResolvedValue(Buffer.from('mock file content')),
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
    creatorUserId: '@owner:test',
    roomId: ROOM,
    streamSessionId: 'ssi-usage',
    sendStreamChunk: () => {},
    toolModules: buildToolRegistry({
      wsFs: mockWsFs,
      workspaceId: 'ws-1',
      workspaceDir: '/tmp/test',
      skillRegistry: mockSkillRegistry,
      streamSessionId: 'ssi-usage',
      roomId: ROOM,
      sendStreamChunk: () => {},
      creatorUserId: '@owner:test',
      permissionConfig: { allowedTools: [], deniedTools: [] },
    }),
  };
}

/** 脚本化 provider：按调用序弹出各轮生成器 */
function scriptProvider(scripts: Array<() => AsyncGenerator<StreamDelta>>): void {
  let call = 0;
  vi.mocked(createLLMProvider).mockReturnValue({
    chat: vi.fn(),
    chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
      const gen = scripts[Math.min(call, scripts.length - 1)]!;
      call++;
      yield* gen();
    }),
  });
}

const finalTextWithUsage = (t: string, p: number, c: number) =>
  async function* (): AsyncGenerator<StreamDelta> {
    yield { type: 'text', content: t };
    yield { type: 'done', finishReason: 'stop', usage: { promptTokens: p, completionTokens: c } };
  };

const toolRoundWithUsage = (p: number, c: number) =>
  async function* (): AsyncGenerator<StreamDelta> {
    yield {
      type: 'tool_use',
      toolCall: { id: 'tc-read', name: 'read_file', arguments: { path: 'a.txt' } },
    };
    yield { type: 'done', finishReason: 'tool_use', usage: { promptTokens: p, completionTokens: c } };
  };

describe('runChatLoop usage 聚合', () => {
  beforeEach(() => {
    vi.mocked(createLLMProvider).mockReset();
    __setMemoryProviderForTest(stubMemoryProvider);
  });
  afterEach(() => {
    __resetMemoryProviderForTest();
  });

  it('工具轮 + 终文轮各带 usage → stats.usageTotal 跨轮整数累加', async () => {
    scriptProvider([
      toolRoundWithUsage(10, 20),
      finalTextWithUsage('总结', 5, 7),
    ]);
    const stats: RunChatLoopStats = { toolCallsUsed: 0 };

    await runChatLoop(ROOM, '读文件并总结', makeConfig(), makeContext(), stats, undefined, undefined, 'ssi-usage');

    expect(stats.usageTotal).toEqual({ promptTokens: 15, completionTokens: 27 });
    expect(stats.toolCallsUsed).toBe(1);
  });

  it('全程无 usage → stats.usageTotal 保持 undefined（不伪造 0）', async () => {
    const plainFinal = async function* (): AsyncGenerator<StreamDelta> {
      yield { type: 'text', content: '回答' };
      yield { type: 'done', finishReason: 'stop' };
    };
    scriptProvider([plainFinal]);
    const stats: RunChatLoopStats = { toolCallsUsed: 0 };

    await runChatLoop(ROOM, '测试', makeConfig(), makeContext(), stats, undefined, undefined, 'ssi-usage');

    expect(stats.usageTotal).toBeUndefined();
  });

  it('部分轮次带 usage → 只累计带 usage 的轮次', async () => {
    const plainToolRound = async function* (): AsyncGenerator<StreamDelta> {
      yield {
        type: 'tool_use',
        toolCall: { id: 'tc-plain', name: 'read_file', arguments: { path: 'b.txt' } },
      };
      yield { type: 'done', finishReason: 'tool_use' };
    };
    scriptProvider([
      toolRoundWithUsage(3, 4), // 轮 1（工具轮）带 usage
      plainToolRound, // 轮 2（工具轮）无 usage
      finalTextWithUsage('终文', 6, 8), // 轮 3 带 usage
    ]);
    const stats: RunChatLoopStats = { toolCallsUsed: 0 };

    await runChatLoop(ROOM, '测试', makeConfig(), makeContext(), stats, undefined, undefined, 'ssi-usage');

    expect(stats.usageTotal).toEqual({ promptTokens: 9, completionTokens: 12 });
  });
});

describe('runTaskChatLoop usage 传播（task-end / task_reply IPC）', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  const originalSend = process.send;

  beforeEach(() => {
    sentIpc.length = 0;
    exitCode = null;
    vi.mocked(createLLMProvider).mockReset();
    __setMemoryProviderForTest(stubMemoryProvider);

    process.send = ((msg: unknown, callback?: (err: Error | null) => void): boolean => {
      sentIpc.push(msg);
      if (callback) callback(null);
      return true;
    }) as NonNullable<typeof process.send>;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null): never => {
      exitCode = typeof code === 'number' ? code : 0;
      return undefined as never;
    });
  });
  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
    exitSpy.mockRestore();
  });

  function makeTaskConfig(overrides: Partial<TaskConfig> = {}): TaskConfig {
    return {
      type: 'task-config',
      taskId: null,
      executionSessionId: ROOM,
      body: 'hi',
      streamSessionId: 'sess-usage-1',
      ...overrides,
    };
  }

  it('成功路径：task-end IPC 携带 usageTotal（与 toolCallsUsed 同型 camelCase）', async () => {
    scriptProvider([finalTextWithUsage('完成', 11, 13)]);

    await runTaskChatLoop(makeTaskConfig({ taskId: 'task-u1' }), makeConfig(), makeContext());

    const taskEnd = sentIpc.find((m) => (m as { type?: string }).type === 'task-end') as {
      toolCallsUsed?: number;
      usageTotal?: { promptTokens: number; completionTokens: number };
    };
    expect(taskEnd).toBeDefined();
    expect(taskEnd.toolCallsUsed).toBe(0);
    expect(taskEnd.usageTotal).toEqual({ promptTokens: 11, completionTokens: 13 });
    expect(exitCode).toBe(0);
  });

  it('dispatch 任务：task_reply 终态回执携带 usage_total（snake_case 线协议）', async () => {
    scriptProvider([finalTextWithUsage('子任务完成', 20, 22)]);

    await runTaskChatLoop(
      makeTaskConfig({
        streamSessionId: 'sess-usage-2',
        dispatchContext: {
          fromAssignmentId: 'inst-pm',
          task_id: 'chain-usage-1',
          tool_stream_session_id: 'pm-ssi',
        },
      }),
      makeConfig(),
      makeContext(),
    );

    // 心跳（in_progress）先行——取终态 completed 回执
    const reply = sentIpc.find(
      (m) =>
        (m as { type?: string }).type === 'momo-internal-event' &&
        (m as { eventType?: string }).eventType === 'io.momo-studio.task_reply' &&
        (m as { content?: { status?: string } }).content?.status === 'completed',
    ) as { content?: { usage_total?: { prompt_tokens: number; completion_tokens: number } } };
    expect(reply).toBeDefined();
    expect(reply.content?.usage_total).toEqual({ prompt_tokens: 20, completion_tokens: 22 });

    // task-end 同样携带（两通道同值——主进程双 settle 入口幂等消费）
    const taskEnd = sentIpc.find((m) => (m as { type?: string }).type === 'task-end') as {
      usageTotal?: { promptTokens: number; completionTokens: number };
    };
    expect(taskEnd.usageTotal).toEqual({ promptTokens: 20, completionTokens: 22 });
  });

  it('无 usage → task-end 与 task_reply 均不携带 usage 字段', async () => {
    const plainFinal = async function* (): AsyncGenerator<StreamDelta> {
      yield { type: 'text', content: '回答' };
      yield { type: 'done', finishReason: 'stop' };
    };
    scriptProvider([plainFinal]);

    await runTaskChatLoop(
      makeTaskConfig({
        streamSessionId: 'sess-usage-3',
        dispatchContext: { fromAssignmentId: 'inst-pm', task_id: 'chain-usage-2' },
      }),
      makeConfig(),
      makeContext(),
    );

    const taskEnd = sentIpc.find((m) => (m as { type?: string }).type === 'task-end') as {
      usageTotal?: unknown;
    };
    expect(taskEnd).toBeDefined();
    expect('usageTotal' in (taskEnd as object)).toBe(false);
    const reply = sentIpc.find(
      (m) =>
        (m as { type?: string }).type === 'momo-internal-event' &&
        (m as { eventType?: string }).eventType === 'io.momo-studio.task_reply' &&
        (m as { content?: { status?: string } }).content?.status === 'completed',
    ) as { content?: Record<string, unknown> };
    expect(reply.content && 'usage_total' in reply.content).toBe(false);
  });

  it('错误路径：task-end(error) 同样携带 usageTotal（失败回合消耗也是真实数据）', async () => {
    // 第一轮带 tool_use + usage，工具执行后第二轮 provider 抛错
    let call = 0;
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
        call++;
        if (call === 1) {
          yield* toolRoundWithUsage(8, 2)();
        } else {
          throw new Error('LLM 服务不可用');
        }
      }),
    });

    await runTaskChatLoop(makeTaskConfig({ taskId: 'task-u-err' }), makeConfig(), makeContext());

    const taskEnd = sentIpc.find((m) => (m as { type?: string }).type === 'task-end') as {
      error?: string;
      usageTotal?: { promptTokens: number; completionTokens: number };
    };
    expect(taskEnd).toBeDefined();
    expect(taskEnd.error).toContain('LLM 服务不可用');
    expect(taskEnd.usageTotal).toEqual({ promptTokens: 8, completionTokens: 2 });
    expect(exitCode).toBe(1);
  });
});
