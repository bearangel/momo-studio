// electron/tests/agent/runtime-segment.test.ts
//
// A7 fix 测试：task_complete 多段消息分段时，主进程应为每段 INSERT 独立的
// message row（segment_of / segment_index 字段正确），不丢失段分隔信号。
//
// 两路覆盖：
//   1. routeChunkToBuffer（主进程侧）：segment_boundary chunk → SQLite 分段 row
//   2. runChatLoop（子进程侧）：task_complete 分段时发 segment_boundary chunk
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { MatrixClient } from 'matrix-js-sdk';
import type { LLMMessage, StreamDelta } from '../../src/main/agent/llm-provider';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';
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
  __routeChunkToBufferForTest,
  __resetEventBufferForTest,
  __flushEventBufferForTest,
} from '../../src/main/agent/runtime-manager';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import {
  getMessageByStreamSessionId,
  listMessagesByRoom,
} from '../../src/main/storage/messages/repo';
import { listEventsByMessage } from '../../src/main/storage/messages/events-repo';

// === DB 测试夹具 ===

const tmpRoot = path.join(os.tmpdir(), `ap-seg-${Date.now()}`);

function setupDb(): void {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
}

function teardownDb(): void {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
}

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

// === 测试 1：routeChunkToBuffer segment_boundary → SQLite 分段 row ===

describe('routeChunkToBuffer: segment_boundary 创建独立分段 message row', () => {
  beforeEach(() => {
    setupDb();
    __resetEventBufferForTest();
  });

  afterEach(() => {
    __resetEventBufferForTest();
    teardownDb();
  });

  it('segment_boundary chunk 在 messages 表插入独立分段 row（segment_of/segment_index 正确）', () => {
    // 1. 先发 start chunk 建父 message
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-1',
      roomId: '!room:localhost',
      botUserId: '@bot:localhost',
    });
    const parent = getMessageByStreamSessionId('ss-1');
    expect(parent).not.toBeNull();
    expect(parent!.sender).toBe('@bot:localhost');

    // 2. 发 segment_boundary chunk（模拟 task_complete 第 1 段）
    __routeChunkToBufferForTest({
      type: 'segment_boundary',
      streamSessionId: 'ss-1',
      segmentIndex: 1,
      segmentBody: '第一段内容',
      segmentStreamSessionId: 'ss-1#seg1',
    });
    __flushEventBufferForTest();

    // 3. messages 表应有 2 行（父 + 分段）
    const rows = listMessagesByRoom('!room:localhost');
    expect(rows).toHaveLength(2);

    // 4. 分段 row 字段正确
    const seg = getMessageByStreamSessionId('ss-1#seg1');
    expect(seg).not.toBeNull();
    expect(seg!.segmentOf).toBe('ss-1');
    expect(seg!.segmentIndex).toBe(1);
    expect(seg!.body).toBe('第一段内容');
    expect(seg!.status).toBe('done');
    expect(seg!.sender).toBe('@bot:localhost');
    expect(seg!.roomId).toBe('!room:localhost');
  });

  it('多段分段：每段一条独立 row，segment_index 递增', () => {
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-2',
      roomId: '!room:localhost',
      botUserId: '@bot:localhost',
    });

    // 第 1 段
    __routeChunkToBufferForTest({
      type: 'segment_boundary',
      streamSessionId: 'ss-2',
      segmentIndex: 1,
      segmentBody: '段一',
      segmentStreamSessionId: 'ss-2#seg1',
    });
    // 第 2 段
    __routeChunkToBufferForTest({
      type: 'segment_boundary',
      streamSessionId: 'ss-2',
      segmentIndex: 2,
      segmentBody: '段二',
      segmentStreamSessionId: 'ss-2#seg2',
    });
    __flushEventBufferForTest();

    const rows = listMessagesByRoom('!room:localhost');
    // 父 + 2 段 = 3 行
    expect(rows).toHaveLength(3);

    const seg1 = getMessageByStreamSessionId('ss-2#seg1');
    expect(seg1!.segmentIndex).toBe(1);
    expect(seg1!.segmentOf).toBe('ss-2');
    const seg2 = getMessageByStreamSessionId('ss-2#seg2');
    expect(seg2!.segmentIndex).toBe(2);
    expect(seg2!.segmentOf).toBe('ss-2');
  });

  it('父 message 不存在时静默跳过（不抛错）', () => {
    // 不发 start chunk，直接发 segment_boundary —— 父 message 不存在
    __routeChunkToBufferForTest({
      type: 'segment_boundary',
      streamSessionId: 'ss-orphan',
      segmentIndex: 1,
      segmentBody: '孤儿段',
      segmentStreamSessionId: 'ss-orphan#seg1',
    });
    __flushEventBufferForTest();

    // 不应插入任何 row
    const rows = listMessagesByRoom('!room:localhost');
    expect(rows).toHaveLength(0);
  });

  it('分段 row 关联一条 final event（携带 body）', () => {
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-3',
      roomId: '!room:localhost',
      botUserId: '@bot:localhost',
    });
    __routeChunkToBufferForTest({
      type: 'segment_boundary',
      streamSessionId: 'ss-3',
      segmentIndex: 1,
      segmentBody: '段内容',
      segmentStreamSessionId: 'ss-3#seg1',
    });
    __flushEventBufferForTest();

    const seg = getMessageByStreamSessionId('ss-3#seg1');
    const events = listEventsByMessage(seg!.id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const finalEvent = events.find((e) => e.eventType === 'final');
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.payload.body).toBe('段内容');
  });

  it('segment_boundary 后父 message 的后续 events 仍关联父（路由不切换）', () => {
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-4',
      roomId: '!room:localhost',
      botUserId: '@bot:localhost',
    });
    // 分段
    __routeChunkToBufferForTest({
      type: 'segment_boundary',
      streamSessionId: 'ss-4',
      segmentIndex: 1,
      segmentBody: '段一',
      segmentStreamSessionId: 'ss-4#seg1',
    });
    // 分段后的 text chunk 仍用父 streamSessionId —— 应关联父 message
    __routeChunkToBufferForTest({
      type: 'text',
      streamSessionId: 'ss-4',
      delta: '继续输出',
    });
    __flushEventBufferForTest();

    const parent = getMessageByStreamSessionId('ss-4')!;
    const parentEvents = listEventsByMessage(parent.id);
    // status_change + text_delta（分段后的 text 关联父）
    const textEvent = parentEvents.find((e) => e.eventType === 'text_delta');
    expect(textEvent).toBeDefined();
    expect(textEvent!.payload.delta).toBe('继续输出');
  });
});

// === 测试 2：runChatLoop task_complete 分段时发 segment_boundary chunk ===

describe('runChatLoop: task_complete 分段发 segment_boundary chunk', () => {
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
