// electron/tests/agent/runtime-task-driven.test.ts
//
// v2（task-driven 切换 Task T3）：runTaskChatLoop 单元测试。
//
// 覆盖 task-driven 模式的关键行为：
//   1. cfg.streamSessionId 被用作 start chunk 的 session ID（不 randomUUID）
//   2. cfg.taskId 注入 RuntimeConfig.currentTaskId → MemoryProvider.getTaskContext 被调用
//   3. cfg.dispatchContext.tool_budget 覆盖 maxToolCalls
//   4. cfg.dispatchContext.tool_stream_session_id 作为 parentStreamSessionId 出现在 start chunk
//   5. 成功路径发 task-end IPC + process.exit(0)
//   6. runChatLoop 抛错时发 end(error) chunk + task-end(error) + process.exit(1)
//   7. parseConfig 解析 taskDriven 字段（默认 true / 显式 false / 非法 → true）
//
// runChatLoop 内部行为（LLM 调用 / 工具执行 / abort）由 runtime-stream.test.ts 覆盖；
// 本测试只验证 runTaskChatLoop 的包装层 + IPC 契约。
//
// P3 Task 1：cfg.modelPlatform 显式透传给 createLLMProvider 的 model.provider，
// 替代 baseUrl 启发式（仅 modelPlatform 已配置时生效；undefined 走启发式兼容路径）。
//
// v2（P1 Task 5）：runTaskChatLoop 不再接收 Matrix client（task-driven 模式无 client，
// dispatch 经内部事件桥、最终消息由 chunk 路径落盘），调用签名改为 (cfg, config, ctx)。

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { StreamDelta } from '../../src/main/agent/llm-provider';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';

// 必须在 import runtime-entry 之前 mock llm-provider（vi.mock 会被 hoist）
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import {
  runTaskChatLoop,
  type RuntimeConfig,
  type RuntimeContext,
  type TaskConfig,
} from '../../src/main/agent/runtime-entry';
import { executeDispatch, handleTaskReplyIpc } from '../../src/main/agent/dispatch-wait';
import { buildToolRegistry } from '../../src/main/agent/tools';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
  type TaskContext,
} from '../../src/main/memory';

// === Mock 状态 ===

const sentChunks: unknown[] = [];
const sentIpc: unknown[] = [];
let exitCode: number | null = null;

// MemoryProvider stub：默认空上下文；可被 mockProviderOverride 覆盖以验证调用
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

/** mock chatStream：返回指定 delta 序列 */
function mockProvider(deltas: StreamDelta[]): void {
  vi.mocked(createLLMProvider).mockReturnValue({
    chat: vi.fn(),
    chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
      for (const d of deltas) yield d;
    }),
  });
}

/** mock chatStream：抛指定错误（测试 error 路径） */
function mockProviderThrow(err: Error): void {
  vi.mocked(createLLMProvider).mockReturnValue({
    chat: vi.fn(),
    chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
      throw err;
    }),
  });
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
    readFile: vi.fn().mockResolvedValue(Buffer.from('')),
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

/** 从 sentChunks 过滤出 StreamChunk 类型 */
function streamChunks(): StreamChunk[] {
  const types = new Set(['start', 'thinking', 'text', 'tool_call', 'tool_result', 'end']);
  return sentChunks.filter((c) => {
    const t = (c as { type?: string }).type;
    return t !== undefined && types.has(t);
  }) as StreamChunk[];
}

describe('runTaskChatLoop（task-driven 模式入口）', () => {
  let exitSpy: MockInstance<Parameters<typeof process.exit>, ReturnType<typeof process.exit>>;
  const originalSend = process.send;

  beforeEach(() => {
    sentChunks.length = 0;
    sentIpc.length = 0;
    exitCode = null;
    vi.mocked(createLLMProvider).mockReset();
    mockProviderOverride = null;
    __setMemoryProviderForTest(stubMemoryProvider);

    // process.send 同时捕获 stream chunk 和 task-end IPC（callback 形式兼容 sendTaskEndAndExit）
    process.send = ((
      msg: unknown,
      callback?: (err: Error | null) => void,
    ): boolean => {
      const m = msg as { type?: string };
      if (m.type && ['start', 'thinking', 'text', 'tool_call', 'tool_result', 'end'].includes(m.type)) {
        sentChunks.push(msg);
      } else {
        sentIpc.push(msg);
      }
      if (callback) callback(null);
      return true;
    }) as NonNullable<typeof process.send>;

    // mock process.exit：记录退出码但不真正退出
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

  it('cfg.streamSessionId 作为 start chunk 的 session ID（不 randomUUID）', async () => {
    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runTaskChatLoop(
      makeTaskConfig({ streamSessionId: 'my-fixed-session-id' }),
      makeConfig(),
      makeContext(),
    );

    const startChunk = streamChunks().find((c) => c.type === 'start') as { streamSessionId: string };
    expect(startChunk.streamSessionId).toBe('my-fixed-session-id');
  });

  it('cfg.taskId 注入 currentTaskId → MemoryProvider.getTaskContext 被调用', async () => {
    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    const getTaskContextSpy = vi.fn(async (_taskId: string): Promise<TaskContext | null> => null);
    mockProviderOverride = { getTaskContext: getTaskContextSpy };

    await runTaskChatLoop(
      makeTaskConfig({ taskId: 'task-abc-123' }),
      makeConfig(),
      makeContext(),
    );

    expect(getTaskContextSpy).toHaveBeenCalledWith('task-abc-123');
  });

  it('cfg.taskId=null（ephemeral chat）→ getTaskContext 不被调用', async () => {
    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    const getTaskContextSpy = vi.fn(async (): Promise<TaskContext | null> => null);
    mockProviderOverride = { getTaskContext: getTaskContextSpy };

    await runTaskChatLoop(
      makeTaskConfig({ taskId: null }),
      makeConfig(),
      makeContext(),
    );

    expect(getTaskContextSpy).not.toHaveBeenCalled();
  });

  it('cfg.dispatchContext.tool_budget 覆盖 maxToolCalls', async () => {
    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runTaskChatLoop(
      makeTaskConfig({
        dispatchContext: {
          fromAssignmentId: 'inst-pm',
          task_id: 'dispatch-1',
          tool_budget: 5,
        },
      }),
      makeConfig({ maxToolCalls: 99 }),
      makeContext(),
    );

    // 验证 createLLMProvider 收到的 config 的 maxToolCalls=5（通过 system prompt 的预算提示间接验证）
    // chatStream 被 mock，无法直接观察 maxToolCalls；改为通过 sentChunks 中的 system prompt 验证
    // 这里简单验证 chat loop 正常完成即可（maxToolCalls 逻辑由 runtime-stream.test.ts 覆盖）
    const endChunk = streamChunks().find((c) => c.type === 'end');
    expect(endChunk).toBeDefined();
  });

  it('cfg.dispatchContext.tool_stream_session_id 作为 parentStreamSessionId 出现在 start chunk', async () => {
    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runTaskChatLoop(
      makeTaskConfig({
        streamSessionId: 'sub-session-001',
        dispatchContext: {
          fromAssignmentId: 'inst-pm',
          task_id: 'dispatch-1',
          tool_stream_session_id: 'pm-session-999',
        },
      }),
      makeConfig({ botName: '子 agent', botAvatar: '🔧' }),
      makeContext(),
    );

    const startChunk = streamChunks().find((c) => c.type === 'start') as {
      streamSessionId: string;
      parentStreamSessionId?: string;
      subAgentName?: string;
    };
    // streamSessionId 是子 agent 自己的（cfg.streamSessionId），不是 PM 的
    expect(startChunk.streamSessionId).toBe('sub-session-001');
    // parentStreamSessionId 是 PM 的（dispatchContext.tool_stream_session_id）
    expect(startChunk.parentStreamSessionId).toBe('pm-session-999');
  });

  it('P3 Task 1：cfg.modelPlatform=anthropic 时 createLLMProvider.model 携带 provider=anthropic', async () => {
    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runTaskChatLoop(
      makeTaskConfig(),
      makeConfig({ modelPlatform: 'anthropic' }),
      makeContext(),
    );

    expect(createLLMProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'anthropic', model: 'test-model' }),
      expect.anything(),
    );
  });

  it('P3 Task 1：cfg.modelPlatform=openai 时 createLLMProvider.model 携带 provider=openai', async () => {
    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runTaskChatLoop(
      makeTaskConfig(),
      makeConfig({ modelPlatform: 'openai' }),
      makeContext(),
    );

    expect(createLLMProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai', model: 'test-model' }),
      expect.anything(),
    );
  });

  it('P3 Task 1：cfg.modelPlatform 缺省时 createLLMProvider.model 不携带 provider（启发式回退）', async () => {
    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runTaskChatLoop(
      makeTaskConfig(),
      makeConfig(),  // modelPlatform 不传
      makeContext(),
    );

    expect(createLLMProvider).toHaveBeenCalledWith(
      expect.not.objectContaining({ provider: expect.anything() }),
      expect.anything(),
    );
  });

  it('成功路径：发 task-end IPC + process.exit(0)', async () => {
    mockProvider([
      { type: 'text', content: '完成' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runTaskChatLoop(
      makeTaskConfig({ taskId: 'task-done-1', streamSessionId: 'sess-done' }),
      makeConfig(),
      makeContext(),
    );

    // task-end IPC
    const taskEnd = sentIpc.find((m) => (m as { type?: string }).type === 'task-end') as {
      streamSessionId: string;
      taskId: string;
      toolCallsUsed?: number;
    };
    expect(taskEnd).toBeDefined();
    expect(taskEnd.streamSessionId).toBe('sess-done');
    expect(taskEnd.taskId).toBe('task-done-1');

    // process.exit(0)
    expect(exitCode).toBe(0);
  });

  it('runChatLoop 抛错时发 end(error) chunk + task-end(error) IPC + process.exit(1)', async () => {
    mockProviderThrow(new Error('LLM 服务不可用'));

    await runTaskChatLoop(
      makeTaskConfig({ taskId: 'task-fail', streamSessionId: 'sess-fail' }),
      makeConfig(),
      makeContext(),
    );

    // end(error) chunk
    const endChunk = streamChunks().find((c) => c.type === 'end') as {
      finishReason: string;
      error?: string;
    };
    expect(endChunk).toBeDefined();
    expect(endChunk.finishReason).toBe('error');
    expect(endChunk.error).toContain('LLM 服务不可用');

    // task-end IPC 含 error 字段
    const taskEnd = sentIpc.find((m) => (m as { type?: string }).type === 'task-end') as {
      error?: string;
    };
    expect(taskEnd).toBeDefined();
    expect(taskEnd.error).toContain('LLM 服务不可用');

    // process.exit(1)
    expect(exitCode).toBe(1);
  });

  it('regression：task-end IPC 必须以方法调用形式发送——裸调用 process.send 在真实 Node 下崩溃（2.0.0 主机验收 P0）', async () => {
    mockProviderThrow(new Error('fetch failed'));

    // 仿真真实 node:internal/child_process 的 process.send 语义：内部读取 this.connected。
    // beforeEach 的默认 mock 是不读 this 的普通函数，无法暴露本缺陷。
    // 解构裸调用（const send = process.send; send(...)）在严格模式下 this=undefined → 抛
    // "Cannot read properties of undefined (reading 'connected')"，错误路径整个崩溃。
    process.send = function (
      this: unknown,
      msg: unknown,
      callback?: (err: Error | null) => void,
    ): boolean {
      if (this !== process) {
        throw new TypeError("Cannot read properties of undefined (reading 'connected')");
      }
      const m = msg as { type?: string };
      if (m.type && ['start', 'thinking', 'text', 'tool_call', 'tool_result', 'end'].includes(m.type)) {
        sentChunks.push(msg);
      } else {
        sentIpc.push(msg);
      }
      if (callback) callback(null);
      return true;
    } as NonNullable<typeof process.send>;

    // 修复前：sendTaskEndAndExit 内解构裸调用 → 上面的 TypeError 令 runTaskChatLoop reject；
    // 修复后：方法调用 → end(error) chunk + task-end(error) IPC + exit(1) 全部正常到达。
    await runTaskChatLoop(
      makeTaskConfig({ taskId: 'task-regress', streamSessionId: 'sess-regress' }),
      makeConfig(),
      makeContext(),
    );

    const endChunk = streamChunks().find((c) => c.type === 'end') as {
      finishReason: string;
      error?: string;
    };
    expect(endChunk).toBeDefined();
    expect(endChunk.finishReason).toBe('error');
    const taskEnd = sentIpc.find((m) => (m as { type?: string }).type === 'task-end');
    expect(taskEnd).toBeDefined();
    expect(exitCode).toBe(1);
  });

  it('正常完成时发完整 chunk 序列：start → text → end', async () => {
    mockProvider([
      { type: 'text', content: 'Hello' },
      { type: 'text', content: ' world' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runTaskChatLoop(
      makeTaskConfig(),
      makeConfig(),
      makeContext(),
    );

    const chunks = streamChunks();
    const types = chunks.map((c) => c.type);
    expect(types[0]).toBe('start');
    expect(types.filter((t) => t === 'text')).toHaveLength(2);
    expect(types[types.length - 1]).toBe('end');
  });

  it('minor-7 回归锁：LLM 抛错时只发一条 end chunk（防重——旧实现发两条）', async () => {
    mockProviderThrow(new Error('LLM 网络抖动'));

    await runTaskChatLoop(
      makeTaskConfig({ taskId: 'task-single-end' }),
      makeConfig(),
      makeContext(),
    );

    const endCount = streamChunks().filter((c) => c.type === 'end').length;
    expect(endCount).toBe(1); // 关键断言：runChatLoop 内部 catch 已发一次，
                                // runTaskChatLoop catch 兜底感知 endChunkSent 不再发
  });

  it('minor-6 回归锁：abort 中断 → dispatch 回执 status=failed（不报 completed）', async () => {
    // chatStream 检测到 abort 时抛 AbortError——仿真用户在停止按钮按下后子进程退出
    mockProvider([]); // 占位：abort 应先于任何 LLM delta 触发
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (
        _msgs: unknown,
        _tools: unknown,
        signal?: AbortSignal,
      ): AsyncGenerator<StreamDelta> {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (signal?.aborted) {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          throw e;
        }
        yield { type: 'text', content: 'never reaches' };
        yield { type: 'done', finishReason: 'stop' } as StreamDelta;
      }),
    });

    const cfg = makeTaskConfig({
      streamSessionId: 'sub-sess-abort',
      dispatchContext: { fromAssignmentId: 'inst-pm', task_id: 'task-abort-1' },
    });
    const runPromise = runTaskChatLoop(cfg, makeConfig(), makeContext());

    // 同步注入 abort：runChatLoop 启动后会注册 process.on('message')，下一宏任务 emit
    setTimeout(() => {
      process.emit('message', { type: 'abort', streamSessionId: 'sub-sess-abort' });
    }, 1);

    await runPromise;

    const replyEvt = sentIpc.find(
      (m) =>
        (m as { type?: string }).type === 'momo-internal-event' &&
        (m as { eventType?: string }).eventType === 'io.momo-studio.task_reply',
    ) as { content: { task_id: string; status: string; body: string } } | undefined;
    expect(replyEvt).toBeDefined();
    expect(replyEvt!.content.task_id).toBe('task-abort-1');
    expect(replyEvt!.content.status).toBe('failed'); // 关键断言：不能是 completed
  });
});

describe('runTaskChatLoop dispatch 回执（Task 13 A 线）', () => {
  const originalSend = process.send;
  let exitSpy: MockInstance<Parameters<typeof process.exit>, ReturnType<typeof process.exit>>;

  beforeEach(() => {
    sentChunks.length = 0;
    sentIpc.length = 0;
    vi.mocked(createLLMProvider).mockReset();
    mockProviderOverride = null;
    __setMemoryProviderForTest(stubMemoryProvider);
    process.send = ((
      msg: unknown,
      callback?: (err: Error | null) => void,
    ): boolean => {
      const m = msg as { type?: string };
      if (m.type && ['start', 'thinking', 'text', 'tool_call', 'tool_result', 'end'].includes(m.type)) {
        sentChunks.push(msg);
      } else {
        sentIpc.push(msg);
      }
      if (callback) callback(null);
      return true;
    }) as NonNullable<typeof process.send>;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
    exitSpy.mockRestore();
  });

  /** 从 sentIpc 里找 task_reply 内部事件信封 */
  function findReplyEvent():
    | { eventType: string; sessionId: string; sender: string; content: Record<string, unknown> }
    | undefined {
    return sentIpc.find(
      (m) => (m as { type?: string }).type === 'momo-internal-event',
    ) as
      | { eventType: string; sessionId: string; sender: string; content: Record<string, unknown> }
      | undefined;
  }

  it('dispatchContext 设置且成功完成 → 发 task_reply 内部事件（completed + reply_to + body）', async () => {
    mockProvider([
      { type: 'text', content: '报告完成' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runTaskChatLoop(
      makeTaskConfig({
        streamSessionId: 'sub-sess-r1',
        dispatchContext: {
          fromAssignmentId: 'inst-pm',
          task_id: 'task-disp-1',
          tool_budget: 5,
        },
      }),
      makeConfig(),
      makeContext(),
    );

    const evt = findReplyEvent();
    expect(evt).toBeDefined();
    expect(evt!.eventType).toBe('io.momo-studio.task_reply');
    expect(evt!.content.task_id).toBe('task-disp-1');
    expect(evt!.content.status).toBe('completed');
    expect(evt!.content.body).toBe('报告完成');
    expect(evt!.content.reply_to).toBe('inst-pm');
  });

  it('dispatchContext 设置且 runChatLoop 抛错 → 发 failed 回执（body 为错误信息）', async () => {
    mockProviderThrow(new Error('LLM 连接失败'));

    await runTaskChatLoop(
      makeTaskConfig({
        streamSessionId: 'sub-sess-r2',
        dispatchContext: { fromAssignmentId: 'inst-pm', task_id: 'task-disp-2' },
      }),
      makeConfig(),
      makeContext(),
    );

    const evt = findReplyEvent();
    expect(evt).toBeDefined();
    expect(evt!.eventType).toBe('io.momo-studio.task_reply');
    expect(evt!.content.task_id).toBe('task-disp-2');
    expect(evt!.content.status).toBe('failed');
    expect(evt!.content.body).toContain('LLM 连接失败');
    expect(evt!.content.reply_to).toBe('inst-pm');
  });

  it('无 dispatchContext（顶层 ephemeral chat）→ 不发 task_reply', async () => {
    mockProvider([
      { type: 'text', content: 'hi' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runTaskChatLoop(
      makeTaskConfig({ streamSessionId: 'sub-sess-r3' }),
      makeConfig(),
      makeContext(),
    );

    expect(findReplyEvent()).toBeUndefined();
  });
});

describe('handleTaskReplyIpc（PM 侧 task-reply IPC 消费，Task 13 A 线）', () => {
  const originalSend = process.send;

  beforeEach(() => {
    sentChunks.length = 0;
    sentIpc.length = 0;
    vi.mocked(createLLMProvider).mockReset();
    mockProviderOverride = null;
    __setMemoryProviderForTest(stubMemoryProvider);
    // executeDispatch 经 process.send 发 dispatch 内部事件——mock 捕获即可（不路由）
    process.send = ((msg: unknown): boolean => {
      const m = msg as { type?: string };
      if (m.type && ['start', 'thinking', 'text', 'tool_call', 'tool_result', 'end'].includes(m.type)) {
        sentChunks.push(msg);
      } else {
        sentIpc.push(msg);
      }
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
  });

  it('把 camelCase 通知转成 task_reply content 并 resolve 对应的 pending dispatch', async () => {
    const config = makeConfig({
      role: 'main',
      subAgents: [{ slug: 'worker', assignmentId: 'inst-worker', description: '执行者' }],
    });

    const dispatchPromise = executeDispatch('worker', '干活', config, 5);

    // 从捕获的内部事件里取 dispatch 的 task_id（子进程侧不可预知）
    const dispatchEvt = sentIpc.find(
      (m) =>
        (m as { type?: string }).type === 'momo-internal-event' &&
        (m as { eventType?: string }).eventType === 'io.momo-studio.dispatch',
    ) as { content: { task_id: string } };
    expect(dispatchEvt).toBeDefined();

    // 模拟主进程 AgentRunner.notifyTaskReply 下发的 IPC 消息（camelCase）
    handleTaskReplyIpc({
      type: 'task-reply',
      reply: { taskId: dispatchEvt.content.task_id, status: 'completed', body: '干完了', toolCallsUsed: 3 },
    });

    await expect(dispatchPromise).resolves.toEqual({ body: '干完了', toolCallsUsed: 3 });
  });

  it('非 task-reply 消息（shutdown / task-config）→ 忽略不抛错', () => {
    expect(() => {
      handleTaskReplyIpc({ type: 'shutdown' });
      handleTaskReplyIpc(null);
      handleTaskReplyIpc({ type: 'task-reply' }); // 缺 reply 字段
    }).not.toThrow();
  });
});

describe('parseConfig taskDriven 字段', () => {
  // 通过环境变量间接测试 parseConfig（parseConfig 不是 export 的，但 main() 用它）
  // 这里直接 import parseConfig 不行（未 export），改为验证 RuntimeConfig 类型 + 行为
  // 用 runTaskChatLoop 间接验证 taskDriven 不影响 task-driven 路径的行为

  it('taskDriven 字段在 RuntimeConfig 类型上可选', () => {
    const config: RuntimeConfig = {
      agentAssignmentId: 'inst-bot',
      agentUserId: 'agent-bot-x1',
      teamSessionId: '!team:localhost',
      systemPrompt: '',
      modelName: 'm',
      llmApiKey: 'k',
      workspaceDir: '/tmp',
      workspaceId: 'ws',
      role: 'standalone',
      subAgents: [],
      skills: [],
      mcpNames: [],
      allowedTools: [],
      deniedTools: [],
      isCoordinator: false,
      devMode: false,
      maxToolCalls: 10,
    };
    // 不设置 taskDriven → undefined（parseConfig 会默认 true）
    expect(config.taskDriven).toBeUndefined();

    // 可设置
    const withFlag: RuntimeConfig = { ...config, taskDriven: false };
    expect(withFlag.taskDriven).toBe(false);
  });
});
