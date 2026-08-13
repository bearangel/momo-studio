// electron/tests/agent/runtime-stream.test.ts
//
// 测试 runChatLoop 的流式 chunk 发送、预算管理、abort 逻辑。
// 不测完整 Matrix 集成——mock createLLMProvider 的 chatStream + MatrixClient + process.send。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import type { LLMMessage, LLMToolDef, StreamDelta } from '../../src/main/agent/llm-provider';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';

// 必须在 import runtime-entry 之前 mock llm-provider（vi.mock 会被 hoist）
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import {
  runChatLoop,
  formatBudgetHint,
  executeDispatch,
  handleTaskReply,
  type RuntimeConfig,
  type RuntimeContext,
  type RunChatLoopStats,
} from '../../src/main/agent/runtime-entry';
import { buildToolRegistry } from '../../src/main/agent/tools';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

// B11：MemoryProvider stub。默认空对话 + 无 task（messages = [system, user]）；单测通过 mockProviderOverride 覆盖。
let mockProviderOverride: Partial<MemoryProvider> | null = null;
const stubMemoryProvider: MemoryProvider = {
  getTaskContext: async (taskId: string) =>
    mockProviderOverride?.getTaskContext
      ? mockProviderOverride.getTaskContext(taskId)
      : null,
  getConversationContext: async (roomId: string, opts) =>
    mockProviderOverride?.getConversationContext
      ? mockProviderOverride.getConversationContext(roomId, opts)
      : { messages: [] },
  getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
  getUserContext: async () => ({ preferences: [] }),
  getWorkspaceContext: async () => null,
};

// === Mock 状态 ===

const sentChunks: unknown[] = [];

/** 从 sentChunks 中过滤出流式 chunk（排除 audit:toolCall 等 IPC 消息） */
function streamChunks(): StreamChunk[] {
  const types = new Set(['start', 'thinking', 'text', 'tool_call', 'tool_result', 'end']);
  return sentChunks.filter((c) => {
    const t = (c as { type?: string }).type;
    return t !== undefined && types.has(t);
  }) as StreamChunk[];
}

/** 构造 mock chatStream——每次调用返回下一个预置的 delta 序列 */
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

/** 构造 mock chatStream——单次调用返回指定 delta 序列 */
function mockProvider(deltas: StreamDelta[]): void {
  mockProviderMultiRound([deltas]);
}

// === Mock MatrixClient ===

function mockClient(): MatrixClient {
  return {
    getRoom: vi.fn().mockReturnValue(null),
    sendEvent: vi.fn().mockResolvedValue({ event_id: '$test:localhost' }),
  } as unknown as MatrixClient;
}

// === Mock RuntimeConfig ===

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    botUserId: '@bot:localhost',
    botAccessToken: 'token',
    homeserverUrl: 'http://localhost:8008',
    teamRoomId: '!team:localhost',
    ownerUserId: '@owner:localhost',
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

// === Mock RuntimeContext ===

function makeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
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
    // v1.5：FileTools 经 ctx.toolModules 路由；其他新增字段留占位
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

// === 测试 ===

describe('runChatLoop streaming', () => {
  const originalSend = process.send;

  beforeEach(() => {
    sentChunks.length = 0;
    vi.mocked(createLLMProvider).mockReset();
    mockProviderOverride = null;
    __setMemoryProviderForTest(stubMemoryProvider);
    process.send = ((msg: unknown): boolean => {
      sentChunks.push(msg);
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
  });

  it('正常完成：发 start → text → end(stop)，并发送最终 m.room.message', async () => {
    mockProvider([
      { type: 'text', content: 'Hello' },
      { type: 'text', content: ' world' },
      { type: 'done', finishReason: 'stop' },
    ]);

    const client = mockClient();
    const result = await runChatLoop(
      client,
      '!room:localhost',
      'hi',
      makeConfig(),
      makeContext(),
    );

    expect(result).toBe('Hello world');

    const chunks = streamChunks();
    expect(chunks[0]!.type).toBe('start');
    expect(chunks.filter((c) => c.type === 'text')).toHaveLength(2);
    expect((chunks[1] as { delta: string }).delta).toBe('Hello');
    expect((chunks[2] as { delta: string }).delta).toBe(' world');
    const endChunk = chunks.find((c) => c.type === 'end') as { finishReason: string };
    expect(endChunk.finishReason).toBe('stop');

    // 验证最终 m.room.message 已发送
    expect(client.sendEvent).toHaveBeenCalledWith(
      '!room:localhost',
      'm.room.message',
      expect.objectContaining({ msgtype: 'm.text', body: 'Hello world' }),
      '',
    );
  });

  it('thinking 增量：发 thinking chunk 并持久化到最终消息', async () => {
    mockProvider([
      { type: 'thinking', content: 'Let me think...' },
      { type: 'text', content: 'Answer' },
      { type: 'done', finishReason: 'stop' },
    ]);

    const client = mockClient();
    await runChatLoop(client, '!room:localhost', 'hi', makeConfig(), makeContext());

    const chunks = streamChunks();
    const thinking = chunks.filter((c) => c.type === 'thinking');
    expect(thinking).toHaveLength(1);
    expect((thinking[0] as { delta: string }).delta).toBe('Let me think...');

    // A7：thinking 不再写入 Matrix event（改由 SQLite message_events 承载）。
    // 最终消息只含 body + msgtype + stream_session_id。
    expect(client.sendEvent).toHaveBeenCalledWith(
      '!room:localhost',
      'm.room.message',
      expect.objectContaining({ msgtype: 'm.text', body: 'Answer' }),
      '',
    );
  });

  it('工具调用：发 tool_call → tool_result → text → end(stop)', async () => {
    const toolCall: { id: string; name: string; arguments: Record<string, unknown> } = {
      id: 'call_1',
      name: 'read_file',
      arguments: { path: 'test.txt' },
    };

    mockProviderMultiRound([
      // 第一轮：LLM 返回工具调用
      [{ type: 'tool_use', toolCall }, { type: 'done', finishReason: 'tool_use' }],
      // 第二轮：工具结果回传后 LLM 给出最终回复
      [{ type: 'text', content: 'Done' }, { type: 'done', finishReason: 'stop' }],
    ]);

    const client = mockClient();
    const ctx = makeContext({
      tools: [
        {
          name: 'read_file',
          description: 'read a file',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    const result = await runChatLoop(
      client,
      '!room:localhost',
      'read test.txt',
      makeConfig(),
      ctx,
    );

    expect(result).toBe('Done');

    const chunks = streamChunks();
    // start → tool_call → tool_result → text → end
    const toolCallChunk = chunks.find((c) => c.type === 'tool_call') as {
      toolName: string;
      args: Record<string, unknown>;
    };
    expect(toolCallChunk.toolName).toBe('read_file');
    expect(toolCallChunk.args).toEqual({ path: 'test.txt' });

    const toolResultChunk = chunks.find((c) => c.type === 'tool_result') as {
      toolName: string;
      result: string;
      success: boolean;
    };
    expect(toolResultChunk.toolName).toBe('read_file');
    expect(toolResultChunk.success).toBe(true);

    // A7：tool_calls 不再写入 Matrix event（改由 SQLite message_events 承载）。
    // 最终消息只含 body + msgtype。
    expect(client.sendEvent).toHaveBeenCalledWith(
      '!room:localhost',
      'm.room.message',
      expect.objectContaining({ msgtype: 'm.text', body: 'Done' }),
      '',
    );
  });

  it('预算耗尽：发 end(budget_exhausted)', async () => {
    // maxToolCalls=1：第一次工具调用后预算归零，第二次工具调用触发 budget_exhausted
    const toolCall1 = { id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } };
    const toolCall2 = { id: 'c2', name: 'read_file', arguments: { path: 'b.txt' } };

    mockProviderMultiRound([
      [{ type: 'tool_use', toolCall: toolCall1 }, { type: 'done', finishReason: 'tool_use' }],
      [{ type: 'tool_use', toolCall: toolCall2 }, { type: 'done', finishReason: 'tool_use' }],
      [{ type: 'text', content: 'final' }, { type: 'done', finishReason: 'stop' }],
    ]);

    const result = await runChatLoop(
      mockClient(),
      '!room:localhost',
      'hi',
      makeConfig({ maxToolCalls: 1 }),
      makeContext({ tools: [{ name: 'read_file', description: '', inputSchema: { type: 'object', properties: {} } }] }),
    );

    const chunks = streamChunks();
    const endChunk = chunks.find((c) => c.type === 'end') as { finishReason: string };
    expect(endChunk.finishReason).toBe('budget_exhausted');

    // 只执行了 1 次工具（第一次后预算归零，第二次触发 budget_exhausted）
    const toolResults = chunks.filter((c) => c.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
  });

  it('maxToolCalls=0：不向 LLM 暴露工具（纯对话模式）', async () => {
    mockProvider([
      { type: 'text', content: 'No tools needed' },
      { type: 'done', finishReason: 'stop' },
    ]);

    const result = await runChatLoop(
      mockClient(),
      '!room:localhost',
      'hi',
      makeConfig({ maxToolCalls: 0 }),
      makeContext({ tools: [{ name: 'read_file', description: '', inputSchema: { type: 'object', properties: {} } }] }),
    );

    expect(result).toBe('No tools needed');
    // chatStream 的 tools 参数应为 undefined
    const mockCall = vi.mocked(createLLMProvider).mock.results[0]!.value as {
      chatStream: ReturnType<typeof vi.fn>;
    };
    const chatStreamCall = mockCall.chatStream.mock.calls[0]!;
    expect(chatStreamCall[1]).toBeUndefined(); // tools 参数
  });

  it('maxToolCalls=-1：无限预算（Infinity）', async () => {
    const rounds: StreamDelta[][] = [];
    for (let i = 0; i < 15; i++) {
      rounds.push([
        { type: 'tool_use', toolCall: { id: `c${i}`, name: 'read_file', arguments: { path: `${i}.txt` } } },
        { type: 'done', finishReason: 'tool_use' as const },
      ]);
    }
    rounds.push([{ type: 'text', content: 'done' }, { type: 'done', finishReason: 'stop' as const }]);

    mockProviderMultiRound(rounds);

    const result = await runChatLoop(
      mockClient(),
      '!room:localhost',
      'hi',
      makeConfig({ maxToolCalls: -1 }),
      makeContext({ tools: [{ name: 'read_file', description: '', inputSchema: { type: 'object', properties: {} } }] }),
    );

    expect(result).toBe('done');
    const chunks = streamChunks();
    const endChunk = chunks.find((c) => c.type === 'end') as { finishReason: string };
    expect(endChunk.finishReason).toBe('stop');
    // 15 次工具调用全部执行（预算无限）
    expect(chunks.filter((c) => c.type === 'tool_result')).toHaveLength(15);
  });

  it('abort：发 end(interrupted)', async () => {
    // chatStream 先 yield 一个 text delta，然后等待 50ms（让测试触发 abort）
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (_msgs, _tools, signal): AsyncGenerator<StreamDelta> {
        yield { type: 'text', content: 'partial' };
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        if (signal.aborted) {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          throw err;
        }
        yield { type: 'text', content: ' rest' };
        yield { type: 'done', finishReason: 'stop' };
      }),
    });

    const promise = runChatLoop(
      mockClient(),
      '!room:localhost',
      'hi',
      makeConfig(),
      makeContext(),
    );

    // 等待 start chunk
    await vi.waitFor(() => {
      expect(streamChunks().some((c) => c.type === 'start')).toBe(true);
    });

    // 触发 abort——模拟主进程通过 IPC 发送 abort 消息
    // （process.emit 的类型签名限制为 Signals，这里直接调用 listeners）
    const startChunk = streamChunks().find((c) => c.type === 'start') as { streamSessionId: string };
    for (const listener of process.listeners('message')) {
      listener({ type: 'abort', streamSessionId: startChunk.streamSessionId }, undefined);
    }

    const result = await promise;

    const chunks = streamChunks();
    expect(result).toBe('partial');
    const endChunk = chunks.find((c) => c.type === 'end') as { finishReason: string };
    expect(endChunk.finishReason).toBe('interrupted');
  });

  it('stats：跟踪工具调用次数', async () => {
    const tc1 = { id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } };
    const tc2 = { id: 'c2', name: 'read_file', arguments: { path: 'b.txt' } };

    mockProviderMultiRound([
      [{ type: 'tool_use', toolCall: tc1 }, { type: 'tool_use', toolCall: tc2 }, { type: 'done', finishReason: 'tool_use' }],
      [{ type: 'text', content: 'done' }, { type: 'done', finishReason: 'stop' }],
    ]);

    const stats: RunChatLoopStats = { toolCallsUsed: 0 };
    await runChatLoop(
      mockClient(),
      '!room:localhost',
      'hi',
      makeConfig({ maxToolCalls: 10 }),
      makeContext({ tools: [{ name: 'read_file', description: '', inputSchema: { type: 'object', properties: {} } }] }),
      stats,
    );

    expect(stats.toolCallsUsed).toBe(2);
  });

  it('start chunk 携带 roomId 和 botUserId', async () => {
    mockProvider([{ type: 'text', content: 'hi' }, { type: 'done', finishReason: 'stop' }]);

    await runChatLoop(
      mockClient(),
      '!special:localhost',
      'hello',
      makeConfig({ botUserId: '@mybot:localhost' }),
      makeContext(),
    );

    const startChunk = streamChunks().find((c) => c.type === 'start') as {
      roomId: string;
      botUserId: string;
    };
    expect(startChunk.roomId).toBe('!special:localhost');
    expect(startChunk.botUserId).toBe('@mybot:localhost');
  });
});

describe('formatBudgetHint', () => {
  it('maxToolCalls=-1（无限）→ 空字符串', () => {
    expect(formatBudgetHint(-1)).toBe('');
  });

  it('maxToolCalls=0（禁用）→ 禁用提示', () => {
    expect(formatBudgetHint(0)).toContain('禁止使用任何工具');
  });

  it('maxToolCalls=N → 含次数提示', () => {
    const hint = formatBudgetHint(5);
    expect(hint).toContain('5');
    expect(hint).toContain('工具调用上限');
  });
});

describe('dispatch 共享预算扣减', () => {
  it('executeDispatch + handleTaskReply 正确传递 toolCallsUsed', async () => {
    const client = mockClient();
    const config = makeConfig({
      role: 'main',
      subAgents: [{ slug: 'researcher', botUserId: '@researcher:localhost', description: 'Research' }],
    });

    const dispatchPromise = executeDispatch('researcher', '帮我查资料', client, config, 9);

    const dispatchContent = vi.mocked(client.sendEvent).mock.calls[0]![2] as unknown as {
      task_id: string;
    };
    handleTaskReply({
      task_id: dispatchContent.task_id,
      body: '资料已找到',
      status: 'completed',
      tool_calls_used: 5,
    });

    const result = await dispatchPromise;
    expect(result).toEqual({ body: '资料已找到', toolCallsUsed: 5 });
  });

  it('tool_calls_used 缺省时默认为 0', async () => {
    const client = mockClient();
    const config = makeConfig({
      role: 'main',
      subAgents: [{ slug: 'researcher', botUserId: '@researcher:localhost', description: 'Research' }],
    });

    const dispatchPromise = executeDispatch('researcher', '任务', client, config);

    const dispatchContent = vi.mocked(client.sendEvent).mock.calls[0]![2] as unknown as {
      task_id: string;
    };
    handleTaskReply({
      task_id: dispatchContent.task_id,
      body: '完成了',
      status: 'completed',
    });

    const result = await dispatchPromise;
    expect(result).toEqual({ body: '完成了', toolCallsUsed: 0 });
  });
});

describe('v1.4 嵌套：dispatch 流式 chip', () => {
  const originalSend = process.send;

  beforeEach(() => {
    sentChunks.length = 0;
    vi.mocked(createLLMProvider).mockReset();
    mockProviderOverride = null;
    __setMemoryProviderForTest(stubMemoryProvider);
    process.send = ((msg: unknown): boolean => {
      sentChunks.push(msg);
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
  });

  it('dispatch tool_call chunk 携带 isDispatch + subStreamSessionId + subAgent 信息', async () => {
    const toolCall = {
      id: 'c1',
      name: 'dispatch:researcher',
      arguments: { task: '查资料' },
    };

    mockProviderMultiRound([
      [{ type: 'tool_use', toolCall }, { type: 'done', finishReason: 'tool_use' }],
      [{ type: 'text', content: '汇总完成' }, { type: 'done', finishReason: 'stop' }],
    ]);

    const client = mockClient();
    // 拦截 dispatch 事件，自动回 task_reply 来 resolve pending
    vi.mocked(client.sendEvent).mockImplementation(async (_roomId, eventType, content) => {
      if (eventType === 'io.momo-studio.dispatch') {
        const taskId = (content as { task_id: string }).task_id;
        setTimeout(() => {
          handleTaskReply({
            task_id: taskId,
            body: '资料已找到',
            status: 'completed',
            tool_calls_used: 0,
          });
        }, 0);
      }
      return { event_id: '$test:localhost' };
    });

    const config = makeConfig({
      role: 'main',
      subAgents: [{ slug: 'researcher', botUserId: '@researcher:localhost', description: '研究员' }],
    });

    await runChatLoop(client, '!room:localhost', '帮我查资料', config, makeContext());

    const chunks = streamChunks();
    const toolCallChunk = chunks.find(
      (c) => c.type === 'tool_call',
    ) as {
      toolName: string;
      isDispatch?: boolean;
      subStreamSessionId?: string;
      subAgentName?: string;
      subAgentAvatar?: string;
    };
    expect(toolCallChunk.toolName).toBe('dispatch:researcher');
    expect(toolCallChunk.isDispatch).toBe(true);
    expect(toolCallChunk.subStreamSessionId).toBeTruthy();
    expect(toolCallChunk.subAgentName).toBe('研究员');
    expect(toolCallChunk.subAgentAvatar).toBe('🤖');
  });

  it('dispatch 成功后 tool_result chunk 携带 subStatus=completed', async () => {
    const toolCall = {
      id: 'c1',
      name: 'dispatch:researcher',
      arguments: { task: '查资料' },
    };

    mockProviderMultiRound([
      [{ type: 'tool_use', toolCall }, { type: 'done', finishReason: 'tool_use' }],
      [{ type: 'text', content: '完成' }, { type: 'done', finishReason: 'stop' }],
    ]);

    const client = mockClient();
    vi.mocked(client.sendEvent).mockImplementation(async (_roomId, eventType, content) => {
      if (eventType === 'io.momo-studio.dispatch') {
        const taskId = (content as { task_id: string }).task_id;
        setTimeout(() => {
          handleTaskReply({ task_id: taskId, body: 'ok', status: 'completed', tool_calls_used: 0 });
        }, 0);
      }
      return { event_id: '$test:localhost' };
    });

    const config = makeConfig({
      role: 'main',
      subAgents: [{ slug: 'researcher', botUserId: '@researcher:localhost', description: 'R' }],
    });

    await runChatLoop(client, '!room:localhost', 'hi', config, makeContext());

    const chunks = streamChunks();
    const toolResultChunk = chunks.find(
      (c) => c.type === 'tool_result',
    ) as { subStatus?: string; success: boolean };
    expect(toolResultChunk.success).toBe(true);
    expect(toolResultChunk.subStatus).toBe('completed');
  });

  it('子 agent start chunk 携带 parentStreamSessionId + subAgentName/Avatar', async () => {
    mockProvider([{ type: 'text', content: 'done' }, { type: 'done', finishReason: 'stop' }]);

    await runChatLoop(
      mockClient(),
      '!room:localhost',
      'task',
      makeConfig({ botName: '研究员', botAvatar: '🔬' }),
      makeContext(),
      undefined,
      'parent-session-123',
    );

    const startChunk = streamChunks().find(
      (c) => c.type === 'start',
    ) as {
      parentStreamSessionId?: string;
      subAgentName?: string;
      subAgentAvatar?: string;
    };
    expect(startChunk.parentStreamSessionId).toBe('parent-session-123');
    expect(startChunk.subAgentName).toBe('研究员');
    expect(startChunk.subAgentAvatar).toBe('🔬');
  });

  it('无 parentStreamSessionId 时 start chunk 不含嵌套字段', async () => {
    mockProvider([{ type: 'text', content: 'done' }, { type: 'done', finishReason: 'stop' }]);

    await runChatLoop(mockClient(), '!room:localhost', 'hi', makeConfig(), makeContext());

    const startChunk = streamChunks().find(
      (c) => c.type === 'start',
    ) as {
      parentStreamSessionId?: string;
      subAgentName?: string;
    };
    expect(startChunk.parentStreamSessionId).toBeUndefined();
    expect(startChunk.subAgentName).toBeUndefined();
  });

  it('子 agent start chunk 携带 parentStreamSessionId（A7：嵌套关系改由 stream chunk 承载）', async () => {
    mockProvider([{ type: 'text', content: 'result' }, { type: 'done', finishReason: 'stop' }]);

    const client = mockClient();
    await runChatLoop(
      client,
      '!room:localhost',
      'task',
      makeConfig(),
      makeContext(),
      undefined,
      'parent-session-456',
    );

    // A7：parent_stream_session_id 不再写入 Matrix event；改由 start chunk 携带，
    // routeChunkToBuffer 据此写入 messages.parent_stream_session_id 列。
    const startChunk = streamChunks().find((c) => c.type === 'start') as {
      parentStreamSessionId?: string;
    };
    expect(startChunk.parentStreamSessionId).toBe('parent-session-456');
  });

  it('A7：最终消息只含 body + stream_session_id（无 io.momo-studio 富字段）', async () => {
    mockProvider([{ type: 'text', content: 'result' }, { type: 'done', finishReason: 'stop' }]);

    const client = mockClient();
    await runChatLoop(client, '!room:localhost', 'hi', makeConfig(), makeContext());

    const call = vi.mocked(client.sendEvent).mock.calls.find(
      ([, type]) => type === 'm.room.message',
    );
    const content = call?.[2] as Record<string, unknown> | undefined;
    // 富字段全部移除（thinking/tool_calls/todos/dispatches/parent_stream_session_id/agent_meta_id）
    expect(content?.['io.momo-studio.parent_stream_session_id']).toBeUndefined();
    expect(content?.['io.momo-studio.thinking']).toBeUndefined();
    expect(content?.['io.momo-studio.tool_calls']).toBeUndefined();
    // 仅保留 stream_session_id（Matrix↔SQLite 行关联用）+ body + msgtype
    expect(content?.['io.momo-studio.stream_session_id']).toBeDefined();
    expect(content?.body).toBeDefined();
  });
});
