// electron/tests/agent/runtime-memory-injection.test.ts
//
// v2.2 记忆 P1 Task 6：runChatLoop 记忆常驻注入接线（spec §6.3）。
//
// 验证：
//   1. 顶层消息 → getPinnedContext 收到 { workspaceId, sessionId=roomId }，hint 拼入 system prompt
//   2. 子 agent（parentStreamSessionId 非空）→ getPinnedContext 收到 sessionId=null（fresh-session
//      语义对齐：不带会话层记忆，全局/工作空间层仍注入），hint 仍拼入 system prompt
//   3. hint=''（记忆关闭/无记忆）→ system prompt 不含记忆段（空视图 no-op，生产默认路径）
//
// 模式对齐 tests/agent/dispatch-fresh-session.test.ts：__setMemoryProviderForTest 注入
// stub + chatStream mock.calls 捕获 LLM messages 断言 system prompt。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreamDelta } from '../../src/main/agent/llm-provider';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';
import type { PinnedMemoryView } from '../../src/main/memory/injection';

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

const MEMORY_HINT =
  '\n\n## 记忆\n### 全局（用户偏好与通用规范）\n- 偏好中文回复';

function makePinnedView(hint: string): PinnedMemoryView {
  return hint
    ? { hint, truncatedCount: 0, pinnedIds: ['g1'] }
    : { hint: '', truncatedCount: 0, pinnedIds: [] };
}

/**
 * 完整 MemoryProvider stub（9 方法全量）。
 * 检索/写路径（search/save/delete）在本测试不被消费——显式抛错而非静默返回占位数据，
 * 若未来 runChatLoop 意外调用会响亮失败（mock 保真度铁律）。
 */
function makeStubProvider(pinnedView: PinnedMemoryView): MemoryProvider & {
  getPinnedContext: ReturnType<typeof vi.fn>;
} {
  const getPinnedContext = vi.fn(
    async (): Promise<PinnedMemoryView> => pinnedView,
  );
  return {
    getPinnedContext,
    getTaskContext: async () => null,
    getConversationContext: async () => ({ messages: [] }),
    getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
    getUserContext: async () => ({ preferences: [] }),
    getWorkspaceContext: async () => null,
    searchMemories: async () => {
      throw new Error('本测试不消费检索路径');
    },
    saveMemory: async () => {
      throw new Error('本测试不消费写路径');
    },
    deleteMemory: async () => {
      throw new Error('本测试不消费写路径');
    },
  };
}

function mockProvider(): void {
  vi.mocked(createLLMProvider).mockReturnValue({
    chat: vi.fn(),
    chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
      yield { type: 'text', content: 'ok' };
      yield { type: 'done', finishReason: 'stop' };
    }),
  });
}

/** 取 chatStream 首次调用收到的 messages（system prompt 断言用，现役模式） */
function firstChatStreamMessages(): Array<{ role: string; content: string }> {
  const chatStream = (
    vi.mocked(createLLMProvider).mock.results[0]!.value as {
      chatStream: ReturnType<typeof vi.fn>;
    }
  ).chatStream;
  const messages = chatStream.mock.calls[0]![0] as Array<{
    role: string;
    content: string;
  }>;
  return messages;
}

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-bot',
    agentUserId: '@bot:localhost',
    teamSessionId: '!team:localhost',
    systemPrompt: 'You are a helpful assistant.',
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

describe('runChatLoop 记忆注入（v2.2 P1 Task 6）', () => {
  beforeEach(() => {
    vi.mocked(createLLMProvider).mockReset();
    mockProvider();
  });

  afterEach(() => {
    __resetMemoryProviderForTest();
  });

  it('顶层消息：getPinnedContext 收到 sessionId=roomId，hint 进入 system prompt', async () => {
    const provider = makeStubProvider(makePinnedView(MEMORY_HINT));
    __setMemoryProviderForTest(provider);

    await runChatLoop('!room:localhost', '你好', makeConfig(), makeContext());

    expect(provider.getPinnedContext).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      sessionId: '!room:localhost',
    });

    const systemContent = firstChatStreamMessages().find(
      (m) => m.role === 'system',
    )!.content;
    expect(systemContent).toContain('## 记忆');
    expect(systemContent).toContain('偏好中文回复');
    // 注入位置：base system prompt 仍在最前（hint 追加在既有 hint 链之后）
    expect(systemContent.startsWith('You are a helpful assistant.')).toBe(
      true,
    );
  });

  it('子 agent（parentStreamSessionId 非空）：getPinnedContext 收到 sessionId=null，hint 仍注入', async () => {
    const provider = makeStubProvider(makePinnedView(MEMORY_HINT));
    __setMemoryProviderForTest(provider);

    await runChatLoop(
      '!room:localhost',
      '干活',
      makeConfig(),
      makeContext(),
      undefined,
      'parent-ssid',
    );

    expect(provider.getPinnedContext).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      sessionId: null,
    });

    const systemContent = firstChatStreamMessages().find(
      (m) => m.role === 'system',
    )!.content;
    expect(systemContent).toContain('## 记忆');
  });

  it("hint=''（记忆关闭/无记忆）→ system prompt 不含记忆段", async () => {
    const provider = makeStubProvider(makePinnedView(''));
    __setMemoryProviderForTest(provider);

    await runChatLoop('!room:localhost', 'hi', makeConfig(), makeContext());

    expect(provider.getPinnedContext).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      sessionId: '!room:localhost',
    });

    const systemContent = firstChatStreamMessages().find(
      (m) => m.role === 'system',
    )!.content;
    expect(systemContent).not.toContain('## 记忆');
  });
});
