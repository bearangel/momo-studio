// electron/tests/agent/runtime-session-context.test.ts
//
// 会话连续性 B 段集成回归锁（spec 2026-09-14 §4.5-1 集成级）：
// 真实 DB seed「bash 指令 → bash 工具对 → aborted」历史回合 + 当前指令行 →
// runChatLoop 首次 LLM 请求的 messages 必须携带完整工具对、当前指令恰一次。
// 模式对齐 runtime-memory-injection.test.ts（mock llm-provider + stub memory）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

// mock electron：stream-relay 生产落库链在测试环境静默降级
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import { runChatLoop, type RuntimeContext } from '../../src/main/agent/runtime-entry';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import { buildToolRegistry } from '../../src/main/agent/tools';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';
import {
  __routeChunkToBufferForTest,
  __resetEventBufferForTest,
  __flushEventBufferForTest,
} from '../../src/main/agent/stream-relay';

const ROOM_ID = '!room:ctx';
const tmpRoot = path.join(os.tmpdir(), `ap-rt-ctx-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  __resetEventBufferForTest();
});

afterEach(() => {
  __resetEventBufferForTest();
  __resetMemoryProviderForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** seed 历史回合（用户案例最小仿真）+ 当前指令行（生产时序：先落库后派发） */
function seedHistory(): void {
  const T0 = Date.now();
  const setTs = (id: string, ts: number): void => {
    getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(ts, id);
  };

  const u1 = insertMessage({ sessionId: ROOM_ID, sender: 'owner', eventType: 'm.room.message', body: '帮我使用bash访问一下bing' });
  setTs(u1.id, T0 + 100);

  __routeChunkToBufferForTest({
    type: 'start', streamSessionId: 'hist-1', sessionId: ROOM_ID, senderAgentId: 'agent-coder-x',
  });
  __flushEventBufferForTest();
  getDb().prepare('UPDATE messages SET created_at = ? WHERE stream_session_id = ?').run(T0 + 200, 'hist-1');

  __routeChunkToBufferForTest({
    type: 'tool_call', streamSessionId: 'hist-1', callId: 'hc1', toolName: 'bash',
    args: { command: 'curl https://www.bing.com' },
  });
  __routeChunkToBufferForTest({
    type: 'tool_result', streamSessionId: 'hist-1', callId: 'hc1', toolName: 'bash',
    result: 'HTTP状态码: 200', success: true,
  });
  __flushEventBufferForTest();
  getDb().prepare(
    `UPDATE message_events SET created_at = ? WHERE created_at < ?`,
  ).run(T0 + 250, T0 + 250);
  __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'hist-1', finishReason: 'interrupted' });
  __flushEventBufferForTest();

  const cur = insertMessage({ sessionId: ROOM_ID, sender: 'owner', eventType: 'm.room.message', body: '访问百度' });
  setTs(cur.id, T0 + 300);
}

/** stub memory：getConversationContext 显式抛错——顶层路径已切换 rebuildSessionContext，误调用即响亮失败 */
function makeStubProvider(): MemoryProvider {
  return {
    getPinnedContext: async (): Promise<PinnedMemoryView> => ({ hint: '', truncatedCount: 0, pinnedIds: [] }),
    getTaskContext: async () => null,
    getConversationContext: async (): Promise<never> => {
      throw new Error('顶层路径不再消费 provider 会话上下文（spec 2026-09-14 B 段）');
    },
    getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
    getUserContext: async () => ({ preferences: [] }),
    getWorkspaceContext: async () => null,
    searchMemories: async () => [],
    saveMemory: async () => {
      throw new Error('本测试不消费写路径');
    },
    deleteMemory: async () => {
      throw new Error('本测试不消费写路径');
    },
  };
}

// 以下 makeConfig / makeContext / mockProvider / firstChatStreamMessages 四个
// helper 逐字照抄 runtime-memory-injection.test.ts:73-155（含 buildToolRegistry
// 组装），本文件仅 ROOM_ID 传 '!room:ctx'。

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
    systemPrompt: 'You are a helpful assistant.',
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
    roomId: ROOM_ID,
    streamSessionId: 'test-session',
    sendStreamChunk: () => {},
    toolModules: buildToolRegistry({
      wsFs: mockWsFs,
      workspaceId: 'ws-1',
      workspaceDir: '/tmp/test',
      creatorUserId: '@owner:test',
      skillRegistry: mockSkillRegistry,
      streamSessionId: 'test-session',
      roomId: ROOM_ID,
      sendStreamChunk: () => {},
      permissionConfig: { allowedTools: [], deniedTools: [] },
    }),
    ...overrides,
  };
}

describe('runChatLoop 顶层上下文 events 级重建（B 段接线）', () => {
  beforeEach(() => {
    vi.mocked(createLLMProvider).mockReset();
    // mockProvider()：chatStream 产出 text + done(stop)
    mockProvider();
  });

  it('历史工具对完整进入新一轮 LLM 请求，当前指令恰出现一次', async () => {
    seedHistory();
    __setMemoryProviderForTest(makeStubProvider());

    await runChatLoop(ROOM_ID, '访问百度', makeConfig(), makeContext());

    const msgs = firstChatStreamMessages() as Array<{
      role: string; content: string; toolCalls?: Array<{ name: string }>; toolCallId?: string;
    }>;
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[1]).toEqual({ role: 'user', content: '帮我使用bash访问一下bing' });
    expect(msgs[2]).toMatchObject({ role: 'assistant', toolCalls: [{ name: 'bash' }] });
    expect(msgs[3]).toMatchObject({ role: 'tool', toolCallId: 'hc1' });
    expect(msgs[4]).toEqual({ role: 'user', content: '访问百度' });
    expect(msgs.filter((m) => m.content === '访问百度')).toHaveLength(1);
    // 中断轮不产生空 assistant 消息
    expect(msgs.some((m) => m.role === 'assistant' && m.content === '' && !m.toolCalls?.length)).toBe(false);
  });
});
