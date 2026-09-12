// electron/tests/agent/dispatch-chain-tagging.test.ts
//
// v2.8.0 Orchestration 元语 Task 5：派发链 task_id 打标基础设施回归锁。
//
// 背景（T1 review 扩面核实）：rebuildSubConversation 按
// `messages WHERE task_id = ? AND session_id = ?` 聚合链历史，但生产
// start chunk 从不携带 taskId、6 处 insertMessage 调用点均不写 task_id——
// 真实数据 followup 永远空链降级。本测试锁三件事：
//   1. stream-relay 落库打标（真实 DB + __routeChunkToBufferForTest 生产链）：
//      start 带 taskId → 该流行打标；不带 → NULL 零变化；roll / segment
//      后续行同标（taskId 是链属性不是流属性）；resume 幂等续流不丢标；
//      end 后 per-stream 记忆清理（同 ssi 复用不串标）。
//   2. runtime-entry start chunk 携带（process.send 捕获，接线锁）：
//      dispatchContext.task_id（dispatch 子 agent）/ TaskConfig.taskId（任务板）
//      两来源；普通 chat 流（无任务无 dispatch）不携带字段——wire 零变化。
//   3. chain-writer.appendFollowupQuestionRow 落库形状（T6 消费的写入契约）：
//      sender='owner'（重建器 user 轮判定键）+ task_id + session_id 双键 +
//      parent_stream_session_id + body=question。
//
// fixture 保真度（momo-test-rules）：
//   - 真实 db（global-defaults 模式：tmp 目录 + AP_USER_DATA_DIR + runMigrations）
//   - 消息行尽量经真实生产落库链写入（chunk → routeChunkToBuffer → insertMessage）
//   - runtime-entry 侧 mock 收窄在进程 / LLM / MemoryProvider 边界，
//     start chunk 发送路径真实执行
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// mock electron：stream-relay 的 BrowserWindow 推送在测试环境静默降级
//（同 sub-history-reconstructor.test.ts 模式）
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

// 必须在 import runtime-entry 之前 mock llm-provider（vi.mock 会被 hoist）
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import type { StreamDelta } from '../../src/main/agent/llm-provider';
import { createLLMProvider } from '../../src/main/agent/llm-provider';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';
import {
  __routeChunkToBufferForTest,
  __resetEventBufferForTest,
  __flushEventBufferForTest,
} from '../../src/main/agent/stream-relay';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  getMessageByStreamSessionId,
  getLatestMessageByStreamSessionId,
  listMessagesBySession,
} from '../../src/main/storage/messages/repo';
import { runTaskChatLoop, type RuntimeContext } from '../../src/main/agent/runtime-entry';
import type { RuntimeConfig, TaskConfig } from '../../src/main/agent/runtime-config';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';
import { appendFollowupQuestionRow } from '../../src/main/agent/chain-writer';
import { rebuildSubConversation } from '../../src/main/agent/sub-history-reconstructor';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

// === DB 测试夹具（global-defaults 模式） ===

const tmpRoot = path.join(os.tmpdir(), `ap-chain-tag-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  __resetEventBufferForTest();
});

afterEach(() => {
  __resetEventBufferForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// === fixture 常量（值语义与生产一致） ===

/** 链的执行会话 id（messages.session_id 的值） */
const EXEC_SESSION = 'sess-chain-exec';
/** 子 agent 本地身份（config.agentUserId 形态） */
const SUB_SENDER = 'agent-coder-a1b2c3';

// ══════════════════════════════════════════════════════════════════════════
// 1. stream-relay：start chunk taskId → 落库打标
// ══════════════════════════════════════════════════════════════════════════

describe('stream-relay：start chunk taskId → 落库打标', () => {
  /** 经真实生产链发 start chunk（可携带 taskId） */
  function startStream(ssi: string, taskId?: string): void {
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: ssi,
      sessionId: EXEC_SESSION,
      senderAgentId: SUB_SENDER,
      ...(taskId !== undefined ? { taskId } : {}),
    });
  }

  it('1. start 带 taskId → 该流行 task_id 打标（end 终态化后仍保留）', () => {
    startStream('ss-tag-1', 'T-chain-1');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-tag-1', delta: '内容' });
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-tag-1', finishReason: 'stop' });
    __flushEventBufferForTest();

    const row = getMessageByStreamSessionId('ss-tag-1');
    expect(row).not.toBeNull();
    expect(row?.taskId).toBe('T-chain-1');
    expect(row?.status).toBe('done');
  });

  it('2. start 不带 taskId → 行 task_id NULL（普通 chat 流零变化）', () => {
    startStream('ss-plain-1');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-plain-1', delta: '内容' });
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-plain-1', finishReason: 'stop' });
    __flushEventBufferForTest();

    const row = getMessageByStreamSessionId('ss-plain-1');
    expect(row).not.toBeNull();
    expect(row?.taskId).toBeNull();
  });

  it('3. roll 后续行同标（#roll 行带同一 task_id——taskId 是链属性，换行不丢标）', () => {
    startStream('ss-roll-1', 'T-chain-roll');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-roll-1', delta: '旧行' });
    __flushEventBufferForTest();
    __routeChunkToBufferForTest({ type: 'message_roll', streamSessionId: 'ss-roll-1' });
    __flushEventBufferForTest();

    // base 行 + roll 行都打标
    const base = getMessageByStreamSessionId('ss-roll-1');
    expect(base?.taskId).toBe('T-chain-roll');
    expect(base?.status).toBe('done');
    const roll = getLatestMessageByStreamSessionId('ss-roll-1');
    expect(roll).not.toBeNull();
    expect(roll?.id).not.toBe(base?.id);
    expect(roll?.streamSessionId).toBe('ss-roll-1#roll1');
    expect(roll?.taskId).toBe('T-chain-roll');
  });

  it('4. segment_boundary 分段行同标（分段快照行也属链）', () => {
    startStream('ss-seg-1', 'T-chain-seg');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-seg-1', delta: '第一段' });
    __flushEventBufferForTest();
    __routeChunkToBufferForTest({
      type: 'segment_boundary',
      streamSessionId: 'ss-seg-1',
      segmentIndex: 1,
      segmentBody: '第一段产出',
      segmentStreamSessionId: 'ss-seg-1#seg1',
    });
    __flushEventBufferForTest();

    const seg = getMessageByStreamSessionId('ss-seg-1#seg1');
    expect(seg).not.toBeNull();
    expect(seg?.taskId).toBe('T-chain-seg');
    expect(seg?.segmentOf).toBe('ss-seg-1');
  });

  it('5. resume 幂等续流：重发 start（同 ssi 且 streaming）不重复 INSERT 且不丢标', () => {
    startStream('ss-resume-1', 'T-chain-resume');
    startStream('ss-resume-1', 'T-chain-resume');
    __flushEventBufferForTest();

    const count = getDb()
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')
      .get(EXEC_SESSION) as { n: number };
    expect(count.n).toBe(1);
    expect(getMessageByStreamSessionId('ss-resume-1')?.taskId).toBe('T-chain-resume');
  });

  it('6. 旧生产者兼容：重发 start 不带 taskId 但行已打标 → roll 续行经 DB 行回退仍同标', () => {
    startStream('ss-compat-1', 'T-chain-compat');
    // 旧版 start chunk（无 taskId 字段）重发——幂等分支经 existing.taskId 回填记忆
    startStream('ss-compat-1');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-compat-1', delta: 'x' });
    __flushEventBufferForTest();
    __routeChunkToBufferForTest({ type: 'message_roll', streamSessionId: 'ss-compat-1' });
    __flushEventBufferForTest();

    const roll = getLatestMessageByStreamSessionId('ss-compat-1');
    expect(roll?.taskId).toBe('T-chain-compat');
  });

  it('7. end 后 per-stream 记忆清理：同 ssi 复用为无 taskId 新流 → 后续 roll 行不串标', () => {
    // 流 A：带标，正常 end（记忆应随 end 清理）
    startStream('ss-reuse-1', 'T-chain-old');
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-reuse-1', finishReason: 'stop' });
    __flushEventBufferForTest();
    // 流 B：同 ssi 复用（旧 A 行已终态 → 按新流 INSERT），不带 taskId
    startStream('ss-reuse-1');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-reuse-1', delta: '新流' });
    __flushEventBufferForTest();
    __routeChunkToBufferForTest({ type: 'message_roll', streamSessionId: 'ss-reuse-1' });
    __flushEventBufferForTest();

    const roll = getLatestMessageByStreamSessionId('ss-reuse-1');
    expect(roll?.taskId).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. runtime-entry：start chunk 携带 taskId（接线锁）
// ══════════════════════════════════════════════════════════════════════════

/** MemoryProvider stub：空上下文（runChatLoop 的记忆拉取边界） */
const stubMemoryProvider: MemoryProvider = {
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

const sentChunks: unknown[] = [];

/** mock chatStream：一段文本即收束 */
function mockProviderPlain(): void {
  vi.mocked(createLLMProvider).mockReturnValue({
    chat: vi.fn(),
    chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
      yield { type: 'text', content: '完成' };
      yield { type: 'done', finishReason: 'stop' };
    }),
  });
}

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-bot',
    agentUserId: 'agent-bot-a1b2c3',
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

function makeContext(): RuntimeContext {
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
    roomId: 'sess-wiring',
    streamSessionId: 'ss-wiring',
    sendStreamChunk: () => {},
    toolModules: [],
  };
}

function makeTaskConfig(overrides: Partial<TaskConfig> = {}): TaskConfig {
  return {
    type: 'task-config',
    taskId: null,
    executionSessionId: 'sess-wiring',
    body: 'hi',
    streamSessionId: 'ss-wiring-run',
    ...overrides,
  };
}

describe('runtime-entry：start chunk 携带 taskId（接线锁）', () => {
  let exitSpy: MockInstance<Parameters<typeof process.exit>, ReturnType<typeof process.exit>>;
  const originalSend = process.send;

  beforeEach(() => {
    sentChunks.length = 0;
    vi.mocked(createLLMProvider).mockReset();
    __setMemoryProviderForTest(stubMemoryProvider);
    // 捕获 stream chunk（start/end 经模块级 sendStreamChunk → process.send）
    process.send = ((msg: unknown): boolean => {
      const m = msg as { type?: string };
      if (m.type && ['start', 'thinking', 'text', 'tool_call', 'tool_result', 'end'].includes(m.type)) {
        sentChunks.push(msg);
      }
      return true;
    }) as NonNullable<typeof process.send>;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => undefined as never);
    mockProviderPlain();
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
    exitSpy.mockRestore();
  });

  /** 取捕获到的 start chunk */
  function startChunk(): StreamChunk | undefined {
    return sentChunks.find((c) => (c as { type?: string }).type === 'start') as
      | StreamChunk
      | undefined;
  }

  it('8. 接线锁：dispatchContext.task_id → start chunk taskId（dispatch 子 agent 链打标来源）', async () => {
    await runTaskChatLoop(
      makeTaskConfig({
        dispatchContext: {
          fromAssignmentId: 'inst-pm',
          task_id: 'T-chain-dispatch-9',
          tool_stream_session_id: 'ss-pm-parent',
        },
      }),
      makeConfig(),
      makeContext(),
    );

    const chunk = startChunk();
    expect(chunk).toBeDefined();
    expect(chunk?.type === 'start' && chunk.taskId).toBe('T-chain-dispatch-9');
  });

  it('9. 接线锁：TaskConfig.taskId（任务板路径）→ start chunk taskId', async () => {
    await runTaskChatLoop(
      makeTaskConfig({ taskId: 'T-board-12' }),
      makeConfig(),
      makeContext(),
    );

    const chunk = startChunk();
    expect(chunk).toBeDefined();
    expect(chunk?.type === 'start' && chunk.taskId).toBe('T-board-12');
  });

  it('10. 零变化：普通 chat 流（无 taskId 无 dispatchContext）start chunk 不携带 taskId 字段', async () => {
    await runTaskChatLoop(
      makeTaskConfig(),
      makeConfig(),
      makeContext(),
    );

    const chunk = sentChunks.find((c) => (c as { type?: string }).type === 'start') as
      | { type?: string; taskId?: string }
      | undefined;
    expect(chunk).toBeDefined();
    // 字段级缺席（而非 undefined 值）——wire 协议对旧消费者零变化
    expect('taskId' in (chunk ?? {})).toBe(false);
  });

  it('11. 优先级：taskId 与 dispatchContext 同设 → currentTaskId（任务板）优先', async () => {
    await runTaskChatLoop(
      makeTaskConfig({
        taskId: 'T-board-both',
        dispatchContext: {
          fromAssignmentId: 'inst-pm',
          task_id: 'T-chain-both',
          tool_stream_session_id: 'ss-pm-parent',
        },
      }),
      makeConfig(),
      makeContext(),
    );

    const chunk = startChunk();
    expect(chunk?.type === 'start' && chunk.taskId).toBe('T-board-both');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. chain-writer：appendFollowupQuestionRow 落库形状（T6 消费的写入契约）
// ══════════════════════════════════════════════════════════════════════════

describe('chain-writer：appendFollowupQuestionRow 落库形状', () => {
  it('12. user 行形状：sender owner + 双键打标（task_id + session_id）+ parent_stream + body', () => {
    appendFollowupQuestionRow('T-chain-fq', 'sess-chain-fq', 'ss-sub-r1', '把结论展开成表格');

    const rows = listMessagesBySession('sess-chain-fq');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      sender: 'owner',
      eventType: 'm.room.message',
      body: '把结论展开成表格',
      taskId: 'T-chain-fq',
      sessionId: 'sess-chain-fq',
      parentStreamSessionId: 'ss-sub-r1',
      streamSessionId: null,
      status: 'done',
    });
  });

  it('13. 集成：打标流（生产链）+ followup user 行（helper）→ rebuildSubConversation 双键聚合完整链', () => {
    const taskId = 'T-chain-e2e';
    // 首轮：子 agent 流行（经真实生产链写入 + 打标）
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-e2e-r1',
      sessionId: EXEC_SESSION,
      senderAgentId: SUB_SENDER,
      taskId,
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-e2e-r1', delta: '首轮结论' });
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-e2e-r1', finishReason: 'stop' });
    __flushEventBufferForTest();
    // followup 追问 user 行（T5 helper）
    appendFollowupQuestionRow(taskId, EXEC_SESSION, 'ss-e2e-r1', '追问细节');
    // 第二轮：子 agent 新流回复（打标）
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-e2e-r2',
      sessionId: EXEC_SESSION,
      senderAgentId: SUB_SENDER,
      taskId,
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-e2e-r2', delta: '二轮答复' });
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-e2e-r2', finishReason: 'stop' });
    __flushEventBufferForTest();

    const sub = rebuildSubConversation(taskId, EXEC_SESSION);

    // 本任务的核心目的：followup 对真实数据不再是空链
    expect(sub.degraded).toBe(false);
    expect(sub.rounds).toBe(1);
    expect(sub.messages).toEqual([
      { role: 'assistant', content: '首轮结论' },
      { role: 'user', content: '追问细节' },
      { role: 'assistant', content: '二轮答复' },
    ]);
  });
});
