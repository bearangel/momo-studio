// electron/tests/agent/runtime-segment.test.ts
//
// A7 fix 测试：task_complete 多段消息分段时，主进程应为每段 INSERT 独立的
// message row（segment_of / segment_index 字段正确），不丢失段分隔信号。
//
// 覆盖：runChatLoop（子进程侧）——task_complete 分段时发 segment_boundary chunk。
// 主进程侧 routeChunkToBuffer 的分段落盘用例已随 Task 6 平移到
// stream-relay.test.ts（routeChunkToBuffer 迁至 stream-relay.ts）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreamDelta } from '../../src/main/agent/llm-provider';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';

// 必须在 import runtime-entry 之前 mock llm-provider（vi.mock 会被 hoist）
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import {
  runChatLoop,
  type LegacyMatrixClient,
  type RuntimeConfig,
  type RuntimeContext,
} from '../../src/main/agent/runtime-entry';
import { buildToolRegistry } from '../../src/main/agent/tools';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

// === runChatLoop 测试夹具（沿用 runtime-stream.test.ts 模式）===

const sentChunks: unknown[] = [];

function mockProviderMultiRound(rounds: StreamDelta[][]): void {
  let callIndex = 0;
  vi.mocked(createLLMProvider).mockReturnValue({
    chat: vi.fn(),
    chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
      const deltas = rounds[callIndex] ?? rounds[rounds.length - 1]!;
      callIndex++;
      for (const d of deltas) yield d;
    }),
  });
}

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
    isCoordinator: false,
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

// === runChatLoop task_complete 分段时发 segment_boundary chunk ===

describe('runChatLoop: task_complete 分段发 segment_boundary chunk', () => {
  const originalSend = process.send;

  const stubProvider: MemoryProvider = {
    getTaskContext: async () => null,
    getConversationContext: async () => ({ messages: [] }),
    getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
    getUserContext: async () => ({ preferences: [] }),
    getWorkspaceContext: async () => null,
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

  /** 从 sentChunks 过滤 segment_boundary chunk */
  function segmentChunks(): StreamChunk[] {
    return sentChunks.filter((c) => (c as { type?: string }).type === 'segment_boundary') as StreamChunk[];
  }

  it('task_complete 分段时发 segment_boundary chunk（携带 segmentIndex/segmentBody/segmentStreamSessionId）', async () => {
    const summary = '这是第一段的总结内容';
    mockProviderMultiRound([
      // 第一轮：LLM 调 task_complete
      [
        { type: 'tool_use', toolCall: { id: 'c1', name: 'task_complete', arguments: { summary } } },
        { type: 'done', finishReason: 'tool_use' },
      ],
      // 第二轮：LLM 继续输出最终回复
      [{ type: 'text', content: '最终回复' }, { type: 'done', finishReason: 'stop' }],
    ]);

    await runChatLoop(
      mockClient(),
      '!room:localhost',
      '做一个长任务',
      makeConfig(),
      makeContext({
        tools: [
          {
            name: 'task_complete',
            description: '分段',
            inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
          },
        ],
      }),
    );

    const segs = segmentChunks();
    expect(segs).toHaveLength(1);
    const seg = segs[0] as {
      type: string;
      streamSessionId: string;
      segmentIndex: number;
      segmentBody: string;
      segmentStreamSessionId: string;
    };
    // streamSessionId 应与 start chunk 的父 session 一致（runChatLoop 内部生成随机 UUID）
    const startChunk = sentChunks.find((c) => (c as { type?: string }).type === 'start') as
      | { streamSessionId: string }
      | undefined;
    expect(seg.type).toBe('segment_boundary');
    expect(seg.streamSessionId).toBe(startChunk!.streamSessionId);
    expect(seg.segmentIndex).toBe(1);
    expect(seg.segmentBody).toBe(summary);
    expect(seg.segmentStreamSessionId).toBe(`${startChunk!.streamSessionId}#seg1`);
  });

  it('多次 task_complete 发多个 segment_boundary chunk，segmentIndex 递增', async () => {
    mockProviderMultiRound([
      [
        { type: 'tool_use', toolCall: { id: 'c1', name: 'task_complete', arguments: { summary: '段一' } } },
        { type: 'done', finishReason: 'tool_use' },
      ],
      [
        { type: 'tool_use', toolCall: { id: 'c2', name: 'task_complete', arguments: { summary: '段二' } } },
        { type: 'done', finishReason: 'tool_use' },
      ],
      [{ type: 'text', content: '收尾' }, { type: 'done', finishReason: 'stop' }],
    ]);

    await runChatLoop(
      mockClient(),
      '!room:localhost',
      '长任务',
      makeConfig(),
      makeContext({
        tools: [
          {
            name: 'task_complete',
            description: '分段',
            inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
          },
        ],
      }),
    );

    const segs = segmentChunks();
    expect(segs).toHaveLength(2);
    expect((segs[0] as { segmentIndex: number }).segmentIndex).toBe(1);
    expect((segs[1] as { segmentIndex: number }).segmentIndex).toBe(2);
    expect((segs[0] as { segmentBody: string }).segmentBody).toBe('段一');
    expect((segs[1] as { segmentBody: string }).segmentBody).toBe('段二');
  });
});
