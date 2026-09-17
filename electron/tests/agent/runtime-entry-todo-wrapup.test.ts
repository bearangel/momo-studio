// electron/tests/agent/runtime-entry-todo-wrapup.test.ts
//
// P0 回归锁：回合正常终止（finishReason=stop 且无工具调用）时 todo 收敛。
// 症状：agent 建任务清单后，清单最后一项永远不标记完成（面板卡 N-1/N），
// 实际工作已随终文交付。根因：LLM 的 todowrite 是转移驱动（开始下一项才补
// 上一项 completed），最后一项的完成动作与终文重合、无「下一项」触发簿记；
// 而 runChatLoop 正常终止路径原先直接 return，零收敛。
// 修复契约：终止前把 in_progress 项机械标 completed，并在 end chunk 之前
// 推送最终 todo_update（实时面板 + message_events 持久化重放都拿到终态）。
// pending 项不动（未启动 ≠ 完成）；interrupted/error/预算耗尽等强停路径不收敛。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMMessage, StreamDelta } from '../../src/main/agent/llm-provider';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';
import type { TodoItem } from '../../src/main/agent/tools/todo-types';

// 必须在 import runtime-entry 之前 mock llm-provider（vi.mock 会被 hoist）
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

// runChatLoop 断言用窄类型（sentChunks 捕获自 process.send）
interface SentChunk {
  type: string;
  streamSessionId?: string;
  sessionId?: string;
  todos?: TodoItem[];
  finishReason?: string;
}

const SSI = 'todo-wrap-ssi';
const ROOM = '!room:todo-wrap';
const sentChunks: unknown[] = [];

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
  // ctx.streamSessionId 与第 8 参 override 同值——镜像生产接线（runTaskChatLoop
  // 的 runCtx.streamSessionId === streamSessionIdOverride），否则工具写入 key
  // 与收尾收敛读取 key 错位（momo-test-rules #1：mock 必须仿真真实运行时语义）
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

// 模块级共享 stub：防默认 SQLiteMemoryProvider 读宿主真实库（污染 + 脆弱）
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

function seedTodos(items: TodoItem[]): void {
  __setTodosForTest(SSI, items);
}

describe('runChatLoop 回合收尾 todo 收敛', () => {
  const originalSend = process.send;

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
    seedTodos([]);
  });

  it('P0 复现：终文产出后 in_progress 项收敛为 completed，最终 todo_update 在 end 之前推送', async () => {
    seedTodos([
      { id: 't1', subject: '审查 auth.js 本体', status: 'completed', source: 'user' },
      { id: 't2', subject: '查看关联文件', status: 'completed', source: 'user' },
      { id: 't3', subject: '输出分级审查报告与修复建议', status: 'in_progress', source: 'user' },
      { id: 't4', subject: 'agent 自发扩展项', status: 'pending', source: 'agent' },
    ]);
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (_messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
        yield { type: 'text', content: '（审查报告终文）' };
        yield { type: 'done', finishReason: 'stop' };
      }) as never,
    });

    await runChatLoop(ROOM, '审查 auth.js', makeConfig(), makeContext(), undefined, undefined, undefined, SSI);

    const all = sentChunks as SentChunk[];
    const todoChunks = all.filter((c) => c.type === 'todo_update');
    expect(todoChunks).toHaveLength(1);
    expect(todoChunks[0]!.streamSessionId).toBe(SSI);
    expect(todoChunks[0]!.sessionId).toBe(ROOM);
    expect(todoChunks[0]!.todos!.map((t) => t.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'pending',
    ]);
    // 事件顺序：收敛 chunk 必须先于 end（message_events 按 seq 重放，后写胜出）
    const endIdx = all.findIndex((c) => c.type === 'end');
    expect(endIdx).toBeGreaterThan(-1);
    expect(all[endIdx - 1]!.type).toBe('todo_update');
    // store 终态一致（后续 mandate / 导出消费同一份）
    expect(getTodosForSession(SSI).find((t) => t.id === 't3')!.status).toBe('completed');
    expect(getTodosForSession(SSI).find((t) => t.id === 't4')!.status).toBe('pending');
  });

  it('无 in_progress 项时不追加 todo_update（幂等门，避免每次回合多余事件）', async () => {
    seedTodos([
      { id: 't1', subject: '已完成', status: 'completed', source: 'user' },
      { id: 't2', subject: '未启动', status: 'pending', source: 'agent' },
    ]);
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (_messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
        yield { type: 'text', content: '终文' };
        yield { type: 'done', finishReason: 'stop' };
      }) as never,
    });

    await runChatLoop(ROOM, '提问', makeConfig(), makeContext(), undefined, undefined, undefined, SSI);

    const all = sentChunks as SentChunk[];
    expect(all.filter((c) => c.type === 'todo_update')).toHaveLength(0);
    expect(all.find((c) => c.type === 'end')).toBeDefined();
  });

  it('abort 中止不收敛（in_progress 保持——断点续跑语义）', async () => {
    seedTodos([
      { id: 't1', subject: '进行中被中断', status: 'in_progress', source: 'user' },
    ]);
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (_messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
        yield { type: 'text', content: '部分' };
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }) as never,
    });

    await runChatLoop(ROOM, '长任务', makeConfig(), makeContext(), undefined, undefined, undefined, SSI);

    const all = sentChunks as SentChunk[];
    expect(all.filter((c) => c.type === 'todo_update')).toHaveLength(0);
    const end = all.find((c) => c.type === 'end');
    expect(end?.finishReason).toBe('interrupted');
    expect(getTodosForSession(SSI).find((t) => t.id === 't1')!.status).toBe('in_progress');
  });
});
