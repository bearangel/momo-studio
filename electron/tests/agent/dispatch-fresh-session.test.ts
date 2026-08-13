// electron/tests/agent/dispatch-fresh-session.test.ts
//
// v1.7.4 Bug 5 → v2（B 子系统 Task B11）演进测试：
//   - 旧版本（v1.7.4）：通过 dispatchModeHint 字符串提示 + loadRecentHistory 跳过实现 fresh session
//   - 新版本（B11）：通过 MemoryProvider.getConversationContext 跳过实现 fresh session，
//     dispatchModeHint 字符串已删除——fresh 行为由空 convCtx 自然实现
//
// 本测试验证：
//   1. parentStreamSessionId 非空（子 agent）→ getConversationContext 不被调用（fresh session）
//   2. parentStreamSessionId 为空（顶层 agent）→ getConversationContext 被调用（加载历史）
//   3. system prompt 不再含 dispatchModeHint 字符串（B11 已删除）
//   4. currentTaskId 非空 → getTaskContext 被调用，taskHint 注入 system prompt

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import type { StreamDelta } from '../../src/main/agent/llm-provider';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
  type TaskContext,
} from '../../src/main/memory';

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
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';

const sentChunks: unknown[] = [];

function mockProvider(deltas: StreamDelta[]): void {
  vi.mocked(createLLMProvider).mockReturnValue({
    chat: vi.fn(),
    chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
      for (const d of deltas) yield d;
    }),
  });
}

function mockClient(): MatrixClient {
  return {
    getRoom: vi.fn().mockReturnValue(null),
    sendEvent: vi.fn().mockResolvedValue({ event_id: '$test:localhost' }),
  } as unknown as MatrixClient;
}

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    botUserId: '@bot:localhost',
    botAccessToken: 'token',
    homeserverUrl: 'http://localhost:8008',
    teamRoomId: '!team:localhost',
    ownerUserId: '@owner:localhost',
    systemPrompt: '你是研发工程师。',
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
    systemPrompt: '你是研发工程师。',
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

describe('子 agent dispatch fresh session（B11：MemoryProvider 取代 loadRecentHistory）', () => {
  const originalSend = process.send;

  beforeEach(() => {
    sentChunks.length = 0;
    vi.mocked(createLLMProvider).mockReset();
    process.send = ((msg: unknown): boolean => {
      sentChunks.push(msg);
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
  });

  it('parentStreamSessionId 非空（子 agent）→ getConversationContext 不被调用（fresh session）', async () => {
    const getConversationContext = vi.fn(async () => ({ messages: [] }));
    const getTaskContext = vi.fn(async () => null);
    const stubProvider: MemoryProvider = {
      getTaskContext,
      getConversationContext,
      getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
      getUserContext: async () => ({ preferences: [] }),
      getWorkspaceContext: async () => null,
    };
    __setMemoryProviderForTest(stubProvider);

    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runChatLoop(
      mockClient(),
      '!room:localhost',
      'task body',
      makeConfig(),
      makeContext(),
      undefined,
      'parent-session-123',
    );

    expect(getConversationContext).not.toHaveBeenCalled();
    expect(getTaskContext).not.toHaveBeenCalled();
  });

  it('parentStreamSessionId 为空（顶层 agent）→ getConversationContext 被调用', async () => {
    const getConversationContext = vi.fn(async () => ({ messages: [] }));
    const getTaskContext = vi.fn(async () => null);
    const stubProvider: MemoryProvider = {
      getTaskContext,
      getConversationContext,
      getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
      getUserContext: async () => ({ preferences: [] }),
      getWorkspaceContext: async () => null,
    };
    __setMemoryProviderForTest(stubProvider);

    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runChatLoop(
      mockClient(),
      '!room:localhost',
      'hi',
      makeConfig(),
      makeContext(),
    );

    expect(getConversationContext).toHaveBeenCalledWith('!room:localhost', { limit: 20 });
    expect(getTaskContext).not.toHaveBeenCalled();
  });

  it('system prompt 不再含 [dispatch 模式] 字符串（B11 已删除 dispatchModeHint）', async () => {
    const stubProvider: MemoryProvider = {
      getTaskContext: async () => null,
      getConversationContext: async () => ({ messages: [] }),
      getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
      getUserContext: async () => ({ preferences: [] }),
      getWorkspaceContext: async () => null,
    };
    __setMemoryProviderForTest(stubProvider);

    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runChatLoop(
      mockClient(),
      '!room:localhost',
      'task',
      makeConfig(),
      makeContext(),
      undefined,
      'parent-session-123',
    );

    const chatStreamCall = (
      vi.mocked(createLLMProvider).mock.results[0]!.value as {
        chatStream: ReturnType<typeof vi.fn>;
      }
    ).chatStream.mock.calls[0]!;
    const messages = chatStreamCall[0] as Array<{ role: string; content: string }>;
    const systemContent = messages.find((m) => m.role === 'system')!.content;
    expect(systemContent).not.toContain('[dispatch 模式]');
    expect(systemContent).not.toContain('从零开始执行');
  });

  it('currentTaskId 非空 → getTaskContext 被调用，taskHint 注入 system prompt', async () => {
    const taskCtx: TaskContext = {
      task: {
        id: 'task-001',
        workspaceId: 'ws-1',
        executionRoomId: null,
        title: '实现登录页',
        description: '完成登录页 UI 与表单校验',
        status: 'in_progress',
        assigneeBotId: '@bot:localhost',
        createdBy: '@owner:localhost',
        createdAt: 1000,
        updatedAt: 1000,
      },
      events: [
        { seq: 1, eventType: 'tool_call_start', summary: '调用工具 read_file (src/App.tsx)' },
        { seq: 2, eventType: 'tool_call_result', summary: '工具结果 ✓' },
      ],
      artifacts: [
        { toolName: 'edit_file', path: 'src/Login.tsx', action: 'edit' },
      ],
    };
    const getTaskContext = vi.fn(async () => taskCtx);
    const getConversationContext = vi.fn(async () => ({ messages: [] }));
    const stubProvider: MemoryProvider = {
      getTaskContext,
      getConversationContext,
      getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
      getUserContext: async () => ({ preferences: [] }),
      getWorkspaceContext: async () => null,
    };
    __setMemoryProviderForTest(stubProvider);

    mockProvider([
      { type: 'text', content: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runChatLoop(
      mockClient(),
      '!room:localhost',
      '继续',
      makeConfig({ currentTaskId: 'task-001' }),
      makeContext(),
    );

    expect(getTaskContext).toHaveBeenCalledWith('task-001');

    const chatStreamCall = (
      vi.mocked(createLLMProvider).mock.results[0]!.value as {
        chatStream: ReturnType<typeof vi.fn>;
      }
    ).chatStream.mock.calls[0]!;
    const messages = chatStreamCall[0] as Array<{ role: string; content: string }>;
    const systemContent = messages.find((m) => m.role === 'system')!.content;
    expect(systemContent).toContain('[任务上下文]');
    expect(systemContent).toContain('task-001');
    expect(systemContent).toContain('实现登录页');
    expect(systemContent).toContain('src/Login.tsx');
  });
});
