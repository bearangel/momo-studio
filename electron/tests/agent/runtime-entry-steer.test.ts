// electron/tests/agent/runtime-entry-steer.test.ts
//
// chat loop steer 注入（v2.3 spec §5.2）：每轮构建 LLM 请求前 drain pendingSteers。
// 两轮结构用 compact 内联工具衔接（不依赖 toolModules）：第一轮 LLM 返回
// compact 工具调用（内联处理继续循环），轮内 emit steer 消息；第二轮捕获
// messages 断言补充已注入。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMMessage, StreamDelta } from '../../src/main/agent/llm-provider';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';

// 必须在 import runtime-entry 之前 mock llm-provider（vi.mock 会被 hoist）
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import {
  runChatLoop,
  type RuntimeConfig,
  type RuntimeContext,
} from '../../src/main/agent/runtime-entry';
import { buildToolRegistry } from '../../src/main/agent/tools';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

// === runChatLoop 测试夹具（沿用 runtime-segment.test.ts 模式）===

const sentChunks: unknown[] = [];

function mockClient(): LegacyMatrixClient {
  return {
    getRoom: vi.fn().mockReturnValue(null),
    sendEvent: vi.fn().mockResolvedValue({ event_id: '$test:localhost' }),
  } as unknown as LegacyMatrixClient;
}

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-bot',
    agentUserId: '@bot:localhost',
    teamSessionId: '!team:localhost',
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
    toolModules: buildToolRegistry({
      wsFs: mockWsFs,
      workspaceId: 'ws-1',
      workspaceDir: '/tmp/test',
      skillRegistry: mockSkillRegistry,
      streamSessionId: 'test-session',
      roomId: '!room:localhost',
      sendStreamChunk: () => {},
      permissionConfig: { allowedTools: [], deniedTools: [] },
    }),
    ...overrides,
  };
}

// === runChatLoop steer 注入测试 ===

describe('runChatLoop steer 注入', () => {
  const originalSend = process.send;

  const stubProvider: MemoryProvider = {
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

  beforeEach(() => {
    sentChunks.length = 0;
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

  it('流式期间 steer 消息在下一轮 LLM 请求以 [用户中途补充] user message 注入', async () => {
    let callIndex = 0;
    let round2Messages: LLMMessage[] = [];
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
        callIndex++;
        if (callIndex === 1) {
          yield { type: 'text', content: '先总结' };
          yield {
            type: 'tool_use',
            toolCall: { id: 'c1', name: 'compact', arguments: { summary: 'S'.repeat(60) } },
          };
          yield { type: 'done', finishReason: 'tool_use' };
          // compact 内联处理在 generator 结束后、下一轮 drain 前执行——此刻注入 steer
          process.emit('message', { type: 'steer', streamSessionId: 's-steer', body: '补充说明 X' });
          return;
        }
        round2Messages = [...messages];
        yield { type: 'text', content: '收到补充' };
        yield { type: 'done', finishReason: 'stop' };
      }) as never,
    });

    const stats = { toolCallsUsed: 0 };
    await runChatLoop('!room:t', '初始问题', makeConfig(), makeContext(), stats, undefined, undefined, 's-steer');

    const supplement = round2Messages.find(
      (m) => m.role === 'user' && m.content.includes('[用户中途补充] 补充说明 X'),
    );
    expect(supplement).toBeDefined();
  });

  it('多条 steer FIFO 依次注入为独立 user messages', async () => {
    // 同上结构；第一轮 generator 结束前连续 emit 两条 steer（body1 / body2），
    // 断言 round2Messages 中两条 [用户中途补充] 消息按 emit 顺序出现
    // （filter 后 index0.content 以 body1 结尾、index1 以 body2 结尾）
    let callIndex = 0;
    let round2Messages: LLMMessage[] = [];
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
        callIndex++;
        if (callIndex === 1) {
          yield { type: 'text', content: '先总结' };
          yield {
            type: 'tool_use',
            toolCall: { id: 'c1', name: 'compact', arguments: { summary: 'S'.repeat(60) } },
          };
          yield { type: 'done', finishReason: 'tool_use' };
          // compact 内联处理在 generator 结束后、下一轮 drain 前执行——此刻连续注入两条 steer
          process.emit('message', { type: 'steer', streamSessionId: 's-steer', body: 'body1' });
          process.emit('message', { type: 'steer', streamSessionId: 's-steer', body: 'body2' });
          return;
        }
        round2Messages = [...messages];
        yield { type: 'text', content: '收到补充' };
        yield { type: 'done', finishReason: 'stop' };
      }) as never,
    });

    const stats = { toolCallsUsed: 0 };
    await runChatLoop('!room:t', '初始问题', makeConfig(), makeContext(), stats, undefined, undefined, 's-steer');

    const supplements = round2Messages.filter((m) => m.role === 'user' && m.content.startsWith('[用户中途补充]'));
    expect(supplements).toHaveLength(2);
    expect(supplements[0]!.content).toBe('[用户中途补充] body1');
    expect(supplements[1]!.content).toBe('[用户中途补充] body2');
  });

  it('streamSessionId 不匹配的 steer 消息被忽略', async () => {
    // 同上结构；emit streamSessionId:'s-other' 的 steer，
    // 断言 round2Messages 无任何 [用户中途补充] 消息
    let callIndex = 0;
    let round2Messages: LLMMessage[] = [];
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
        callIndex++;
        if (callIndex === 1) {
          yield { type: 'text', content: '先总结' };
          yield {
            type: 'tool_use',
            toolCall: { id: 'c1', name: 'compact', arguments: { summary: 'S'.repeat(60) } },
          };
          yield { type: 'done', finishReason: 'tool_use' };
          // 注入 streamSessionId 不匹配的 steer——应当被 abortListener 过滤
          process.emit('message', { type: 'steer', streamSessionId: 's-other', body: '其他流的补充' });
          return;
        }
        round2Messages = [...messages];
        yield { type: 'text', content: '收到补充' };
        yield { type: 'done', finishReason: 'stop' };
      }) as never,
    });

    const stats = { toolCallsUsed: 0 };
    await runChatLoop('!room:t', '初始问题', makeConfig(), makeContext(), stats, undefined, undefined, 's-steer');

    const supplements = round2Messages.filter((m) => m.role === 'user' && m.content.startsWith('[用户中途补充]'));
    expect(supplements).toHaveLength(0);
  });

  it('abort 语义与 steer 正交：abort 消息仍触发 interrupted 收尾', async () => {
    // 第一轮 emit steer + 第二轮 generator 开头 emit abort 后抛
    // Object.assign(new Error('中断'), { name: 'AbortError' })
    // 断言：stats.aborted === true、返回值为已累积文本、
    //       round2 messages 中补充已注入（steer 不阻塞不改变 abort 路径）
    let callIndex = 0;
    let round2Messages: LLMMessage[] = [];
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
        callIndex++;
        if (callIndex === 1) {
          yield { type: 'text', content: '先总结' };
          yield {
            type: 'tool_use',
            toolCall: { id: 'c1', name: 'compact', arguments: { summary: 'S'.repeat(60) } },
          };
          yield { type: 'done', finishReason: 'tool_use' };
          // compact 内联处理后注入 steer——下一轮 drain 应当消费
          process.emit('message', { type: 'steer', streamSessionId: 's-steer', body: '补充说明 X' });
          return;
        }
        // 第二轮 generator：先捕获 messages（验证 drain 已注入 steer），再 emit abort 后抛
        round2Messages = [...messages];
        process.emit('message', { type: 'abort', streamSessionId: 's-steer' });
        throw Object.assign(new Error('中断'), { name: 'AbortError' });
      }) as never,
    });

    const stats = { toolCallsUsed: 0 };
    const result = await runChatLoop('!room:t', '初始问题', makeConfig(), makeContext(), stats, undefined, undefined, 's-steer');

    // stats.aborted === true
    expect(stats.aborted).toBe(true);
    // 返回值为已累积文本：round 1 末尾 assistant push 后 accumulatedText 已重置为 ''，
    // round 2 generator 在开头 emit abort + 抛 AbortError 前未产出 text delta，
    // 故 raw accumulatedText 为 ''（abort 分支无 '(空回复)' 兜底）
    expect(result).toBe('');
    // round2 messages 中补充已注入（drain 在 for round 顶部已完成）
    const supplement = round2Messages.find(
      (m) => m.role === 'user' && m.content.includes('[用户中途补充] 补充说明 X'),
    );
    expect(supplement).toBeDefined();
  });
});
