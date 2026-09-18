// electron/tests/agent/runtime-entry-todo-reconcile.test.ts
//
// F1（mandate 死锁）回归锁：终文前仍有 user-source in_progress 待办时，
// 注入一次性「待办收尾校验」合成 user 消息，模型先 todowrite 对齐状态再收尾。
// 症状（2026-09-18 实测会话）：agent 忘记中途标完成 → mandate 每轮宣称
// 「用户请求未完成」→ 模型把滞留状态误读为新的用户请求，同一条指令被完整执行两遍。
// 契约：
//   1. 校验消息以 '[系统] 待办收尾校验' 开头（进 COMPACTION_SYNTHETIC_USER_PREFIXES，
//      不成为压缩锚点）
//   2. 一次性门：无论模型是否修正，最多注入一次（防循环）
//   3. 仅顶层 chat 路径触发（currentTaskId / parentStreamSessionId 路径不触发）
//   4. 预算耗尽不触发（模型需要 todowrite 工具才有意义）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMMessage, StreamDelta } from '../../src/main/agent/llm-provider';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';
import type { TodoItem } from '../../src/main/agent/tools/todo-types';

vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import { runChatLoop, type RuntimeContext } from '../../src/main/agent/runtime-entry';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import { buildToolRegistry } from '../../src/main/agent/tools';
import {
  __setTodosForTest,
  getTodosForSession,
} from '../../src/main/agent/tools/todo-tools';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

interface SentChunk {
  type: string;
  finishReason?: string;
  todos?: TodoItem[];
}

const SSI = 'todo-reconcile-ssi';
const ROOM = '!room:todo-reconcile';
const sentChunks: unknown[] = [];
/** 每次 chatStream 调用捕获的 messages（断言合成条注入形态） */
const capturedCalls: LLMMessage[][] = [];

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
    creatorUserId: '@owner:test',
    roomId: ROOM,
    streamSessionId: SSI,
    sendStreamChunk: () => {},
    toolModules: buildToolRegistry({
      wsFs: mockWsFs,
      workspaceId: 'ws-1',
      workspaceDir: '/tmp/test',
      skillRegistry: mockSkillRegistry,
      streamSessionId: SSI,
      roomId: ROOM,
      sendStreamChunk: () => {},
      creatorUserId: '@owner:test',
      permissionConfig: { allowedTools: [], deniedTools: [] },
    }),
    ...overrides,
  };
}

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

/** 脚本化 provider：每次调用弹出下一个生成器；同时捕获当次 messages */
function scriptProvider(scripts: Array<() => AsyncGenerator<StreamDelta>>): ReturnType<typeof vi.fn> {
  let call = 0;
  return vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
    capturedCalls.push(messages.map((m) => ({ ...m })));
    const gen = scripts[Math.min(call, scripts.length - 1)]!;
    call++;
    yield* gen();
  }) as never;
}

const finalText = (t: string) => async function* (): AsyncGenerator<StreamDelta> {
  yield { type: 'text', content: t };
  yield { type: 'done', finishReason: 'stop' };
};

describe('runChatLoop 收尾校验轮（F1 mandate 死锁）', () => {
  const originalSend = process.send;

  beforeEach(() => {
    sentChunks.length = 0;
    capturedCalls.length = 0;
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
    __setTodosForTest(SSI, []);
  });

  it('滞留 in_progress user 待办 → 注入一次性校验消息，模型修正后正常收尾', async () => {
    __setTodosForTest(SSI, [
      { id: 't1', subject: '委派 CodeForge', status: 'completed', source: 'user' },
      { id: 't2', subject: '委派 PixelMuse', status: 'in_progress', source: 'user' },
    ]);
    const chatStream = scriptProvider([
      finalText('第一段总结'),
      async function* (): AsyncGenerator<StreamDelta> {
        yield {
          type: 'tool_use',
          toolCall: {
            id: 'tc-fix',
            name: 'todowrite',
            arguments: {
              todos: [
                { subject: '委派 CodeForge', status: 'completed', source: 'user' },
                { subject: '委派 PixelMuse', status: 'completed', source: 'user' },
              ],
            },
          },
        };
        yield { type: 'done', finishReason: 'tool_use' };
      },
      finalText('最终总结'),
    ]);
    vi.mocked(createLLMProvider).mockReturnValue({ chat: vi.fn(), chatStream } as never);

    await runChatLoop(ROOM, '测试请求', makeConfig(), makeContext(), undefined, undefined, undefined, SSI);

    expect(chatStream).toHaveBeenCalledTimes(3);
    // 第二次调用注入了合成校验条（前缀进合成清单，不成为压缩锚点）
    const secondCall = capturedCalls[1]!;
    const reconcileMsg = secondCall.find(
      (m) => m.role === 'user' && m.content.startsWith('[系统] 待办收尾校验'),
    );
    expect(reconcileMsg).toBeDefined();
    expect(reconcileMsg!.content).toContain('委派 PixelMuse');
    expect(reconcileMsg!.content).toContain('严禁重复执行已完成的工作');
    // 模型已在校验轮自行标完成 → 终局无多余收敛 chunk，正常 end
    const all = sentChunks as SentChunk[];
    expect(all.find((c) => c.type === 'end')!.finishReason).toBe('stop');
    expect(getTodosForSession(SSI).every((t) => t.status === 'completed')).toBe(true);
  });

  it('一次性门：模型不修正也只注入一次（两轮 LLM 后机械收尾 + 兜底收敛）', async () => {
    __setTodosForTest(SSI, [
      { id: 't1', subject: '滞留项', status: 'in_progress', source: 'user' },
    ]);
    const chatStream = scriptProvider([finalText('总结'), finalText('补充总结')]);
    vi.mocked(createLLMProvider).mockReturnValue({ chat: vi.fn(), chatStream } as never);

    await runChatLoop(ROOM, '测试请求', makeConfig(), makeContext(), undefined, undefined, undefined, SSI);

    expect(chatStream).toHaveBeenCalledTimes(2);
    const reconcileCount = capturedCalls.filter((msgs) =>
      msgs.some((m) => m.role === 'user' && m.content.startsWith('[系统] 待办收尾校验')),
    ).length;
    expect(reconcileCount).toBe(1);
    // 兜底收敛：终局前 completeInProgressTodos 机械标完成（todo_update 先于 end）
    const all = sentChunks as SentChunk[];
    const endIdx = all.findIndex((c) => c.type === 'end');
    expect(all[endIdx - 1]!.type).toBe('todo_update');
    expect(getTodosForSession(SSI)[0]!.status).toBe('completed');
  });

  it('task 域路径（currentTaskId 非空）不触发校验轮', async () => {
    __setTodosForTest(SSI, [
      { id: 't1', subject: '任务项', status: 'in_progress', source: 'user' },
    ]);
    const chatStream = scriptProvider([finalText('任务正文')]);
    vi.mocked(createLLMProvider).mockReturnValue({ chat: vi.fn(), chatStream } as never);

    await runChatLoop(
      ROOM,
      '测试请求',
      makeConfig({ currentTaskId: 'T-1' }),
      makeContext(),
      undefined,
      undefined,
      undefined,
      SSI,
    );

    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(
      capturedCalls.some((msgs) =>
        msgs.some((m) => m.role === 'user' && m.content.startsWith('[系统] 待办收尾校验')),
      ),
    ).toBe(false);
  });

  it('无滞留 in_progress user 待办时不注入校验轮（零开销）', async () => {
    __setTodosForTest(SSI, [
      { id: 't1', subject: '已完成', status: 'completed', source: 'user' },
      { id: 't2', subject: 'agent 备忘', status: 'pending', source: 'agent' },
    ]);
    const chatStream = scriptProvider([finalText('总结')]);
    vi.mocked(createLLMProvider).mockReturnValue({ chat: vi.fn(), chatStream } as never);

    await runChatLoop(ROOM, '测试请求', makeConfig(), makeContext(), undefined, undefined, undefined, SSI);

    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(
      capturedCalls.some((msgs) =>
        msgs.some((m) => m.role === 'user' && m.content.startsWith('[系统] 待办收尾校验')),
      ),
    ).toBe(false);
  });
});
