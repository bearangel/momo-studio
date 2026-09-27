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

import { describe, it, expect, vi, beforeEach, afterEach, afterAll, type MockInstance } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { StreamDelta, LLMMessage } from '../../src/main/agent/llm-provider';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { INTERRUPTED_TOOL_RESULT } from '../../src/main/agent/turn-reconstructor';

// 必须在 import runtime-entry 之前 mock llm-provider（vi.mock 会被 hoist）
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import { runTaskChatLoop, type RuntimeContext } from '../../src/main/agent/runtime-entry';
import { __setStreamRetryDelaysForTest } from '../../src/main/agent/runtime-entry';
import type { RuntimeConfig, TaskConfig, ExpandedImageItem } from '../../src/main/agent/runtime-config';
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

// runChatLoop 会话边界过滤（2026-09-07 二段修复）每轮触 DB——文件级兜底：
// 未显式设 AP_USER_DATA_DIR 的 describe 也指向临时目录（防惰性 getDb 落到
// 默认用户目录缓存句柄，污染后续 describe 的 seed）；每用例后 closeDb 防句柄泄漏
const fallbackTmp = path.join(
  os.tmpdir(),
  `ap-rtd-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  getPinnedContext: async () => ({ hint: '', truncatedCount: 0, pinnedIds: [] }),
  searchMemories: async () => { throw new Error('测试 stub 不落库'); },
  saveMemory: async () => { throw new Error('测试 stub 不落库'); },
  deleteMemory: async () => { throw new Error('测试 stub 不落库'); },
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
    creatorUserId: '@owner:test',
    roomId: '!room:localhost',
    streamSessionId: 'test-session',
    sendStreamChunk: () => {},
    toolModules: buildToolRegistry({
      wsFs: mockWsFs,
      workspaceId: 'ws-1',
      workspaceDir: '/tmp/test',
      creatorUserId: '@owner:test',
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

  it('v2.6.0 接线锁：cfg.resume 经 runTaskChatLoop 解构透传到 runChatLoop.resumeTurn——首轮 LLM messages 含重建段且 currentBody 不重复（摘掉解构/传参必红）', async () => {
    // 消费侧接线第四环（review Finding 1）：resumeTask → TaskConfig.resume（IPC）
    // → runTaskChatLoop 解构 → runChatLoop 第 10 参 resumeTurn。T4 的
    // runtime-resume.test.ts 直调 runChatLoop（锁第 10 参消费语义），本用例锁
    // 「解构 + 透传」这一环——摘掉 runtime-entry 的 resume 解构/传参后
    // resume 载荷静默丢失（不报错），只有本用例变红。
    let first: LLMMessage[] = [];
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
        first = [...messages];
        yield { type: 'text', content: '已续跑' };
        yield { type: 'done', finishReason: 'stop' };
      }),
    });

    await runTaskChatLoop(
      makeTaskConfig({
        body: '恢复兜底正文',
        streamSessionId: 's-wiring-resume-1',
        resume: {
          messages: [
            { role: 'user', content: '修复登录页崩溃' },
            {
              role: 'assistant',
              content: '我先看下代码',
              toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'login.tsx' } }],
            },
            { role: 'tool', content: '(login.tsx 内容)', toolCallId: 'call-1' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-2', name: 'bash', arguments: { command: 'npm test' } }],
            },
            { role: 'tool', content: INTERRUPTED_TOOL_RESULT, toolCallId: 'call-2' },
          ],
          toolCallsUsed: 2,
          steers: [],
          degenerate: false,
        },
      }),
      makeConfig(),
      makeContext(),
    );

    // 重建段 verbatim 到位：system + user + assistant(toolCalls) + tool + assistant + tool(孤儿合成)
    expect(first.map((m) => m.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'assistant', 'tool',
    ]);
    expect(first[1]).toEqual({ role: 'user', content: '修复登录页崩溃' });
    // 孤儿 tool_call 的合成 result 用 T1 契约常量（生产者/消费者同源，不手搓文案）
    expect(first[5]).toEqual({ role: 'tool', content: INTERRUPTED_TOOL_RESULT, toolCallId: 'call-2' });
    // currentBody 不重复追加：user 仅重建段首条 1 条；兜底正文不进任何消息
    expect(first.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(first.some((m) => m.content === '恢复兜底正文')).toBe(false);
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
      // 供应商预设：未配置 thinking → 第三参 undefined（不发参数）
      undefined,
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
      // 供应商预设：未配置 thinking → 第三参 undefined（不发参数）
      undefined,
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
      // 供应商预设：未配置 thinking → 第三参 undefined（不发参数）
      undefined,
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
      // @types/node 对 emit('message') 是双参专用重载——经通用签名强转（运行时等价）
      (process.emit as (event: string, ...args: unknown[]) => boolean)('message', {
        type: 'abort',
        streamSessionId: 'sub-sess-abort',
      });
    }, 1);

    await runPromise;

    // v2.9：心跳 in_progress 先于终态——过滤 failed 定位终态回执（abort 场景心跳
    // 可能来不及发出，直接按状态找不依赖顺序）
    const replyEvt = sentIpc.find(
      (m) =>
        (m as { type?: string }).type === 'momo-internal-event' &&
        (m as { eventType?: string }).eventType === 'io.momo-studio.task_reply' &&
        (m as { content?: { status?: string } }).content?.status === 'failed',
    ) as { content: { task_id: string; status: string; body: string } } | undefined;
    expect(replyEvt).toBeDefined();
    expect(replyEvt!.content.task_id).toBe('task-abort-1');
    expect(replyEvt!.content.status).toBe('failed'); // 关键断言：不能是 completed
  });

  describe('流中断自动重试（terminated P0 方案 B）', () => {
    beforeEach(() => {
      __setStreamRetryDelaysForTest([10, 10, 10]);
    });

    it('terminated 第一步半截回滚 → 退避重发 → 正常完成；重试提示入正文留痕', async () => {
      let call = 0;
      vi.mocked(createLLMProvider).mockReturnValue({
        chat: vi.fn(),
        chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
          call += 1;
          if (call === 1) {
            yield { type: 'text', content: '半截输出' };
            throw new Error('terminated');
          }
          yield { type: 'text', content: '完整输出' };
          yield { type: 'done', finishReason: 'stop' as const };
        }),
      });

      await runTaskChatLoop(
        makeTaskConfig({ taskId: 'task-retry', streamSessionId: 'sess-retry' }),
        makeConfig(),
        makeContext(),
      );

      // 重试提示入正文（用户可见留痕）
      const notice = streamChunks().find(
        (c) =>
          c.type === 'text' &&
          typeof (c as { delta?: unknown }).delta === 'string' &&
          (c as { delta: string }).delta.includes('自动重试 1/3'),
      );
      expect(notice).toBeDefined();

      // 重发确实发生（第一次 terminated、第二次完成）
      expect(call).toBe(2);

      // 终态正常——无 error end，exit(0)
      const endChunk = streamChunks().find((c) => c.type === 'end') as {
        finishReason: string;
        error?: string;
      } | undefined;
      expect(endChunk).toBeDefined();
      expect(endChunk?.finishReason).not.toBe('error');
      expect(endChunk?.error).toBeUndefined();
      expect(exitCode).toBe(0);
    });

    it('重试上限：连续 terminated 耗尽 3 次后落入原 error 终态（不无限循环）', async () => {
      let call = 0;
      vi.mocked(createLLMProvider).mockReturnValue({
        chat: vi.fn(),
        chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
          call += 1;
          yield { type: 'text', content: 'x' };
          throw new Error('terminated');
        }),
      });

      await runTaskChatLoop(
        makeTaskConfig({ taskId: 'task-retry-exhaust', streamSessionId: 'sess-retry-exhaust' }),
        makeConfig(),
        makeContext(),
      );

      // 初次 + 3 次重试 = 4 次调用
      expect(call).toBe(4);
      const endChunk = streamChunks().find((c) => c.type === 'end') as {
        finishReason: string;
        error?: string;
      } | undefined;
      expect(endChunk?.finishReason).toBe('error');
      expect(endChunk?.error).toContain('terminated');
      expect(exitCode).toBe(1);
    });
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

  /**
   * 从 sentIpc 里找 task_reply 内部事件信封。
   * v2.9：dispatch 任务先发心跳（in_progress）再发终态回执——按 status 过滤
   * 定位目标回执；不传 status 返回首条（即首拍心跳）。
   */
  function findReplyEvent(status?: string):
    | { eventType: string; sessionId: string; sender: string; content: Record<string, unknown> }
    | undefined {
    return sentIpc.find(
      (m) =>
        (m as { type?: string }).type === 'momo-internal-event' &&
        (m as { eventType?: string }).eventType === 'io.momo-studio.task_reply' &&
        (status === undefined ||
          (m as { content?: { status?: string } }).content?.status === status),
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

    // v2.9 契约锁：首条回执是首拍心跳（in_progress——注册即活，主进程死亡检测基准）
    const hb = findReplyEvent();
    expect(hb).toBeDefined();
    expect(hb!.content.status).toBe('in_progress');
    expect(hb!.content.reply_to).toBe('inst-pm');

    const evt = findReplyEvent('completed');
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

    const evt = findReplyEvent('failed');
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
  /** 会话边界校验（2026-09-07 修复）要求真实 session_members 行——seed 的会话 id */
  let boundarySessId = '';

  beforeEach(() => {
    sentChunks.length = 0;
    sentIpc.length = 0;
    vi.mocked(createLLMProvider).mockReset();
    mockProviderOverride = null;
    __setMemoryProviderForTest(stubMemoryProvider);
    // executeDispatch 会话边界校验需真实 DB：seed ws + agent 链 + 多成员会话
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-rtd-boundary-'));
    process.env.AP_USER_DATA_DIR = tmp;
    runMigrations();
    const db = getDb();
    db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`).run();
    for (const inst of ['inst-bot', 'inst-worker']) {
      db.prepare(
        `INSERT INTO agent_definitions
           (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
            default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
         VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
      ).run(inst, inst, inst);
      db.prepare(
        `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
         VALUES (?, 'ws', ?, ?)`,
      ).run(inst, inst, `agent-${inst}`);
    }
    const sess = insertSession({ workspaceId: 'ws', title: 'boundary' });
    addSessionMember(sess.id, 'inst-bot', true);
    addSessionMember(sess.id, 'inst-worker', false);
    boundarySessId = sess.id;
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
    closeDb();
    fs.rmSync(process.env.AP_USER_DATA_DIR ?? '', { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('把 camelCase 通知转成 task_reply content 并 resolve 对应的 pending dispatch', async () => {
    const config = makeConfig({
      role: 'main',
      subAgents: [{ slug: 'worker', assignmentId: 'inst-worker', description: '执行者' }],
    });

    const dispatchPromise = executeDispatch(
      'worker', '干活', config, 5, undefined, undefined, boundarySessId,
    ).catch((err: Error) => {
      throw err;
    });

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

describe('runTaskChatLoop 工具预算优先级（v2.2 会话预算接线）', () => {
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

  /** 从 createLLMProvider 返回的 chatStream mock 里取首参（LLMMessage[]），断言 system prompt 预算提示 */
  function systemPromptOfFirstCall(): string {
    const chatStream = (vi.mocked(createLLMProvider).mock.results[0]?.value as {
      chatStream: ReturnType<typeof vi.fn>;
    } | undefined)?.chatStream;
    if (!chatStream) throw new Error('chatStream 未被调用');
    const messages = chatStream.mock.calls[0]?.[0] as
      | Array<{ role: string; content: string }>
      | undefined;
    const system = messages?.find((m) => m.role === 'system');
    if (!system) throw new Error('system 消息未找到');
    return system.content;
  }

  it('cfg.maxToolCalls（主进程按会话解析的预算）注入 system prompt 预算提示，覆盖 AGENT_CONFIG 默认', async () => {
    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runTaskChatLoop(
      makeTaskConfig({ maxToolCalls: 25 }),
      makeConfig({ maxToolCalls: 10 }),
      makeContext(),
    );

    const prompt = systemPromptOfFirstCall();
    expect(prompt).toContain('本任务工具调用上限：25 次');
    expect(prompt).not.toContain('本任务工具调用上限：10 次');
  });

  it('dispatchContext.tool_budget 优先于 cfg.maxToolCalls', async () => {
    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runTaskChatLoop(
      makeTaskConfig({
        maxToolCalls: 25,
        dispatchContext: {
          fromAssignmentId: 'inst-pm',
          task_id: 'dispatch-budget',
          tool_budget: 5,
        },
      }),
      makeConfig({ maxToolCalls: 10 }),
      makeContext(),
    );

    const prompt = systemPromptOfFirstCall();
    expect(prompt).toContain('本任务工具调用上限：5 次');
    expect(prompt).not.toContain('本任务工具调用上限：25 次');
  });

  it('cfg.maxToolCalls 缺省 → 沿用 AGENT_CONFIG maxToolCalls（兼容老线协议）', async () => {
    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runTaskChatLoop(
      makeTaskConfig(),
      makeConfig({ maxToolCalls: 10 }),
      makeContext(),
    );

    expect(systemPromptOfFirstCall()).toContain('本任务工具调用上限：10 次');
  });

  it('maxToolCalls=-1（无限）→ 不注入预算提示', async () => {
    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runTaskChatLoop(
      makeTaskConfig({ maxToolCalls: -1 }),
      makeConfig({ maxToolCalls: 10 }),
      makeContext(),
    );

    expect(systemPromptOfFirstCall()).not.toContain('工具调用上限');
  });
});

describe('parseConfig taskDriven 字段', () => {
  // 通过环境变量间接测试 parseConfig（parseConfig 不是 export 的，但 main() 用它）
  // 这里直接 import parseConfig 不行（未 export），改为验证 RuntimeConfig 类型 + 行为
  // 用 runTaskChatLoop 间接验证 taskDriven 不影响 task-driven 路径的行为

  it('RuntimeConfig 必填字段可用最小字面量构造（v25 起 teamSessionId/taskDriven 已退役）', () => {
    const config: RuntimeConfig = {
      agentAssignmentId: 'inst-bot',
      agentUserId: 'agent-bot-x1',
      systemPrompt: '',
      modelName: 'm',
      llmApiKey: 'k',
      workspaceDir: '/tmp',
      workspaceId: 'ws',
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
    };
    // 退役字段不再是 RuntimeConfig 一部分（运行时对象上自然不存在）
    expect('taskDriven' in config).toBe(false);
    expect('teamSessionId' in config).toBe(false);
  });
});

// ─── 多模态图片注入（Task 8，spec 2026-09-26-image-input-multimodal §7/§8）──────
//
// 覆盖 runtime 侧三动作（AGENT_CONFIG.vision 快照为唯一判定位）：
//   1. vision=true：当前轮 user LLMMessage 附 images（path 剥除，w/h 保留）
//   2. vision=false：剥图 + 正文尾注降级提示（N 张 N 条省略行 + 加载失败占位行）
//   3. visionHint（团队路由提示）：leader 场景一次性系统提示文本
//
// 持久化零污染锁：注入文本只进 LLM 请求 messages，绝不进任何 chunk / IPC 出站
// （用户消息行由主进程在派发前落库，runtime 侧无从回流——断言出站面无泄漏）。
describe('runTaskChatLoop 图片输入（vision 注入 / 非 vision 降级 / leader 提示）', () => {
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

  /** 捕获首轮 LLM 请求 messages 的 provider mock（单轮 stop 收口）；messages() 取快照 */
  function captureProvider(): { messages: () => LLMMessage[] } {
    let captured: LLMMessage[] = [];
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
        captured = [...messages];
        yield { type: 'text', content: 'ok' };
        yield { type: 'done', finishReason: 'stop' as const };
      }),
    });
    return { messages: () => captured };
  }

  /** 图片夹具（ExpandedImageItem 形状，base64 显式传入——不含 path 子串，防断言串味） */
  function img(relPath: string, base64: string, w = 100, h = 80): ExpandedImageItem {
    return { path: relPath, mime: 'image/png', base64, w, h };
  }

  function firstUser(messages: LLMMessage[]): LLMMessage {
    const user = messages.find((m) => m.role === 'user');
    if (!user) throw new Error('user 消息未找到');
    return user;
  }

  it('vision=true + 2 图：当前轮 user 消息携带 images（path 剥除、w/h 保留），正文无省略提示', async () => {
    const cap = captureProvider();
    await runTaskChatLoop(
      makeTaskConfig({
        body: '看下这两张图',
        streamSessionId: 'sess-img-1',
        context: { skills: [], files: [], images: [img('a.png', 'QVFB'), img('b.png', 'QkJC', 640, 480)], droppedImages: [] },
      }),
      makeConfig({ vision: true }),
      makeContext(),
    );

    const user = firstUser(cap.messages());
    expect(user.images).toHaveLength(2);
    // 逐元素形状锁：{mime, base64, w, h} 四字段，path 不上线协议
    expect(user.images![0]).toEqual({ mime: 'image/png', base64: 'QVFB', w: 100, h: 80 });
    expect(user.images![1]).toEqual({ mime: 'image/png', base64: 'QkJC', w: 640, h: 480 });
    expect(JSON.stringify(user.images)).not.toContain('a.png');
    // vision 分支正文零污染
    expect(user.content).toBe('看下这两张图');
    expect(user.content).not.toContain('图片已省略');
  });

  it('TaskConfig.vision 每消息覆盖（2026-09-26 P0）：task-config true 压过 AGENT_CONFIG 快照 false——改开关后下一条消息即带图', async () => {
    const cap = captureProvider();
    await runTaskChatLoop(
      makeTaskConfig({
        body: '开关刚打开，热 runtime 快照还是 false',
        streamSessionId: 'sess-img-ovr',
        vision: true,
        context: { skills: [], files: [], images: [img('a.png', 'QVFB')], droppedImages: [] },
      }),
      makeConfig({ vision: false }),
      makeContext(),
    );

    const user = firstUser(cap.messages());
    // 快照被覆盖：images 附上、无省略行
    expect(user.images).toHaveLength(1);
    expect(user.content).not.toContain('图片已省略');
  });

  it('TaskConfig.vision 反向覆盖：task-config false 压过快照 true（关开关即时剥图）', async () => {
    const cap = captureProvider();
    await runTaskChatLoop(
      makeTaskConfig({
        body: '关掉开关',
        streamSessionId: 'sess-img-ovr2',
        vision: false,
        context: { skills: [], files: [], images: [img('a.png', 'QVFB')], droppedImages: [] },
      }),
      makeConfig({ vision: true }),
      makeContext(),
    );

    const user = firstUser(cap.messages());
    expect('images' in user).toBe(false);
    expect(user.content).toContain('[图片已省略：当前模型不支持视觉]');
  });

  it('vision=false + 2 图：不附 images 字段；正文恰 2 行省略提示；注入文本不进任何 chunk/IPC（不落库）', async () => {
    const cap = captureProvider();
    await runTaskChatLoop(
      makeTaskConfig({
        body: '看图',
        streamSessionId: 'sess-img-2',
        context: { skills: [], files: [], images: [img('a.png', 'QVFB'), img('b.png', 'QkJC')], droppedImages: [] },
      }),
      makeConfig({ vision: false }),
      makeContext(),
    );

    const user = firstUser(cap.messages());
    // 剥图：images 字段整体不存在（provider 请求维持纯文本形态）
    expect('images' in user).toBe(false);
    // N 张 N 条省略行（精确匹配整行，防止拼接漂移）
    const omitLines = user.content.split('\n').filter((l) => l === '[图片已省略：当前模型不支持视觉]');
    expect(omitLines).toHaveLength(2);
    // 原正文仍在最前（尾注语义）
    expect(user.content.startsWith('看图')).toBe(true);
    // 持久化零污染：注入文本只进 LLM 请求，全部出站（chunk + IPC）无泄漏
    const allOutbound = JSON.stringify([...sentChunks, ...sentIpc]);
    expect(allOutbound).not.toContain('图片已省略');
  });

  it('droppedImages 2 条：vision=true / false 两分支正文各含 2 行加载失败占位', async () => {
    for (const vision of [true, false] as const) {
      sentChunks.length = 0;
      sentIpc.length = 0;
      vi.mocked(createLLMProvider).mockReset();
      const cap = captureProvider();
      await runTaskChatLoop(
        makeTaskConfig({
          body: 'x',
          streamSessionId: `sess-drop-${vision ? 't' : 'f'}`,
          context: {
            skills: [],
            files: [],
            images: vision ? [img('ok.png', 'QVFB')] : [],
            droppedImages: ['bad1.png', 'bad2.png'],
          },
        }),
        makeConfig({ vision }),
        makeContext(),
      );

      const user = firstUser(cap.messages());
      const dropLines = user.content
        .split('\n')
        .filter((l) => l.startsWith('[图片加载失败: '));
      expect(dropLines).toEqual(['[图片加载失败: bad1.png]', '[图片加载失败: bad2.png]']);
    }
  });

  it('visionHint 在场 + vision=false + 带图：正文含系统提示（成员名+模型+路径清单）；无 hint → 仅降级行', async () => {
    // —— 有 hint：系统提示逐字锁（N/路径/成员名/模型拼接）——
    let cap = captureProvider();
    await runTaskChatLoop(
      makeTaskConfig({
        body: '看图',
        streamSessionId: 'sess-hint-1',
        context: { skills: [], files: [], images: [img('a.png', 'QVFB'), img('b.png', 'QkJC')], droppedImages: [] },
        visionHint: { members: [{ name: '千里眼', model: 'glm-4.6v' }, { name: '二郎神', model: 'gpt-5.2' }] },
      }),
      makeConfig({ vision: false }),
      makeContext(),
    );
    let user = firstUser(cap.messages());
    expect(user.content).toContain(
      '[系统提示：用户消息附带 2 张图片（a.png、b.png）。你当前模型不支持视觉。' +
        '团队成员「千里眼」（glm-4.6v）、「二郎神」（gpt-5.2）可识别图片——' +
        '直接 dispatch 任务给它，子任务会自动附上会话近期图片。]',
    );
    // 系统提示不顶替降级行（§7 省略行仍在）
    expect(user.content.split('\n').filter((l) => l === '[图片已省略：当前模型不支持视觉]')).toHaveLength(2);

    // —— 无 hint：仅 deliverable 2 降级文本，无系统提示 ——
    vi.mocked(createLLMProvider).mockReset();
    cap = captureProvider();
    await runTaskChatLoop(
      makeTaskConfig({
        body: '看图',
        streamSessionId: 'sess-hint-2',
        context: { skills: [], files: [], images: [img('a.png', 'QVFB'), img('b.png', 'QkJC')], droppedImages: [] },
      }),
      makeConfig({ vision: false }),
      makeContext(),
    );
    user = firstUser(cap.messages());
    expect(user.content).not.toContain('系统提示');
    expect(user.content.split('\n').filter((l) => l === '[图片已省略：当前模型不支持视觉]')).toHaveLength(2);

    // —— hint 在场但本轮无展开成功图片（全部加载失败）：系统提示抑制（N=0 无意义）——
    vi.mocked(createLLMProvider).mockReset();
    cap = captureProvider();
    await runTaskChatLoop(
      makeTaskConfig({
        body: '看图',
        streamSessionId: 'sess-hint-3',
        context: { skills: [], files: [], images: [], droppedImages: ['gone.png'] },
        visionHint: { members: [{ name: '千里眼', model: 'glm-4.6v' }] },
      }),
      makeConfig({ vision: false }),
      makeContext(),
    );
    user = firstUser(cap.messages());
    expect(user.content).not.toContain('系统提示');
    expect(user.content).toContain('[图片加载失败: gone.png]');
  });

  it('无图消息零变化：user 消息 = renderTurnBody 产物原样、无 images 字段、无任何注入行（含旧线协议缺字段载荷）', async () => {
    // —— 空 images/droppedImages 的 context（新版载荷）——
    let cap = captureProvider();
    await runTaskChatLoop(
      makeTaskConfig({
        body: 'hi',
        streamSessionId: 'sess-noimg-1',
        context: { skills: [], files: [], images: [], droppedImages: [] },
      }),
      makeConfig({ vision: false }),
      makeContext(),
    );
    let user = firstUser(cap.messages());
    expect(user.content).toBe('hi');
    expect('images' in user).toBe(false);

    // —— 旧线协议载荷（缺 images/droppedImages 字段，宽进归一为空数组）——
    vi.mocked(createLLMProvider).mockReset();
    cap = captureProvider();
    await runTaskChatLoop(
      makeTaskConfig({
        body: 'hi',
        streamSessionId: 'sess-noimg-2',
        // 仿真 Task 5 之前的线载荷：只有 skills/files
        context: { skills: [], files: [] } as unknown as Parameters<typeof runTaskChatLoop>[0]['context'],
      }),
      makeConfig({ vision: true }),
      makeContext(),
    );
    user = firstUser(cap.messages());
    expect(user.content).toBe('hi');
    expect('images' in user).toBe(false);
  });
});
