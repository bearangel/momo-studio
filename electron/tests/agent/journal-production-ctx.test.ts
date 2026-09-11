// electron/tests/agent/journal-production-ctx.test.ts
//
// v2.5 终审 C1 生产形态回归锁：task-config 注入路径 → 工具执行 → 账本条目
// streamSessionId / sessionId 命中真实值。
//
// 背景（终审根因链）：WarmPool 预 spawn 时任务未分配，buildSpawnOpts 产物不含
//   streamSessionId/roomId → 子进程 parseConfig 二者缺省 ''（runtime-config.ts
//   270-273）→ 真实值经 child.send({type:'task-config'}) 后置注入，仅存在于
//   cfg。若 runTaskChatLoop 不把 cfg 值织入 per-run ctx，doExecuteTool 组装的
//   toolCtx 恒为空串 → buildRecordCtx 产出 stream_session_id='' / session_id=null
//   → 消息行的真实预分配 id 永不命中 journal:list → chip 全灭。
//
// 与 journal-wiring.test.ts 的分工：wiring 锁「doExecuteTool 会记账」（其 ctx
//   手搓携带真实值）；本文件锁「真实值只能经 task-config 注入路径到达账本」——
//   fixture 的 boot ctx 刻意保持生产空串形态，禁止手搓携带真实值（否则本锁
//   失效，正是 wiring 测试全绿但 C1 仍进生产的原因）。
//
// 形态：真实 runTaskChatLoop → runChatLoop → executeTool → doExecuteTool →
//   FileTools → change-journal → recorder → 真实 SQLite 账本；只 mock 进程/网络
//   边界（llm-provider 网络调用 / process.send / process.exit / MemoryProvider
//   DB 边界 stub——runtime-task-driven.test.ts 同款先例）。
//
// 红绿验证（I1）：临时把 runTaskChatLoop 内 runChatLoop 的 ctx 参数从 per-run
//   变体改回 boot ctx → 两用例变红（条目落 '' 键、sessionId=null）。

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { StreamDelta } from '../../src/main/agent/llm-provider';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';
import { WorkspaceFS } from '../../src/main/files/workspace-fs';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';

// 必须在 import runtime-entry 之前 mock llm-provider（vi.mock 会被 hoist）——
// LLM API 是网络边界，生产中不可达
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import { runTaskChatLoop, type RuntimeContext } from '../../src/main/agent/runtime-entry';
import type { TaskConfig } from '../../src/main/agent/runtime-config';
import { buildToolRegistry } from '../../src/main/agent/tools';
import { createJournalStore, type JournalStore } from '../../src/main/journal/store';
import { __setJournalStoreForTest } from '../../src/main/journal/recorder';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

const sentChunks: unknown[] = [];

/** MemoryProvider stub（DB 边界降级，runtime-task-driven.test.ts 同款） */
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

/** mock chatStream：每次调用返回下一个预置的 delta 序列（多轮工具循环用） */
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

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-bot',
    agentUserId: '@bot:localhost',
    systemPrompt: '',
    modelName: 'test',
    llmApiKey: 'k',
    workspaceDir: '',
    workspaceId: 'ws-j',
    role: 'standalone',
    subAgents: [],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: false,
    devMode: false,
    maxToolCalls: 10,
    contextWindow: 0,
    outputTokens: 0,
    ...overrides,
  };
}

/**
 * 生产形态 boot ctx：streamSessionId/roomId 均为空串（parseConfig 对预 spawn
 * 子进程的缺省产物）。真实值只允许经 cfg（task-config）注入——本函数是
 * C1 回归锁的成立前提。
 */
function makeBootCtx(workspaceDir: string, workspaceId: string): RuntimeContext {
  const wsFs = new WorkspaceFS(workspaceDir);
  const skillRegistry = { list: () => [] } as never;
  const sendStreamChunk = (): void => {};
  const registryCtx = {
    wsFs,
    workspaceId,
    workspaceDir,
    skillRegistry,
    streamSessionId: '',
    roomId: '',
    sendStreamChunk,
    permissionConfig: { allowedTools: [] as string[], deniedTools: [] as string[] },
    creatorUserId: 'test-user',
  };
  return {
    wsFs,
    skillRegistry,
    tools: [],
    systemPrompt: '',
    workspaceId,
    workspaceDir,
    roomId: '',
    streamSessionId: '',
    sendStreamChunk,
    creatorUserId: 'test-user',
    toolModules: buildToolRegistry(registryCtx),
  };
}

function makeTaskConfig(overrides: Partial<TaskConfig> = {}): TaskConfig {
  return {
    type: 'task-config',
    taskId: 'T-42',
    executionSessionId: 'sess-exec-1',
    body: '写入文件',
    streamSessionId: 'ssn-real-1',
    ...overrides,
  };
}

/** write_file 工具轮 + 终文轮（两轮驱动真实 executeTool 路径） */
function mockToolRoundRobin(): void {
  mockProviderMultiRound([
    [
      {
        type: 'tool_use',
        toolCall: { id: 'call_1', name: 'write_file', arguments: { path: 'a.ts', content: 'x' } },
      },
      { type: 'done', finishReason: 'tool_use' },
    ],
    [{ type: 'text', content: '完成' }, { type: 'done', finishReason: 'stop' }],
  ]);
}

describe('变更账本生产形态回归锁（task-config 注入路径，终审 C1/I1）', () => {
  const udRoot = path.join(os.tmpdir(), `momo-v25-prodctx-ud-${Date.now()}`);
  const originalSend = process.send;
  let tmpDir: string;
  let bootCtx: RuntimeContext;
  let store: JournalStore;
  let exitSpy: MockInstance<Parameters<typeof process.exit>, ReturnType<typeof process.exit>>;

  beforeEach(() => {
    // 真实迁移建库 + 真实账本 store（journal-wiring.test.ts 同款，不手搓表）
    fs.mkdirSync(udRoot, { recursive: true });
    process.env.AP_USER_DATA_DIR = udRoot;
    runMigrations();
    store = createJournalStore(getDb());
    __setJournalStoreForTest(store);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-v25-prodctx-ws-'));
    bootCtx = makeBootCtx(tmpDir, 'ws-j');
    sentChunks.length = 0;
    vi.mocked(createLLMProvider).mockReset();
    __setMemoryProviderForTest(stubMemoryProvider);

    // process.send 捕获 chunk/IPC（callback 形式兼容 sendTaskEndAndExit）
    process.send = ((
      msg: unknown,
      callback?: (err: Error | null) => void,
    ): boolean => {
      sentChunks.push(msg);
      if (callback) callback(null);
      return true;
    }) as NonNullable<typeof process.send>;

    // runTaskChatLoop 收尾 process.exit(0)——记录不真退
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
    __setJournalStoreForTest(null);
    exitSpy.mockRestore();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(udRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('顶层任务：task-config 注入的 streamSessionId/executionSessionId 到达账本条目', async () => {
    mockToolRoundRobin();
    const cfg = makeTaskConfig();

    await runTaskChatLoop(cfg, makeConfig({ workspaceDir: tmpDir }), bootCtx);

    // 工具确实经 chat loop 真实执行（而非直接调 doExecuteTool）
    const toolResult = sentChunks.find(
      (c) => (c as StreamChunk).type === 'tool_result',
    ) as { success: boolean } | undefined;
    expect(toolResult?.success).toBe(true);

    // 关键断言：条目挂在 cfg.streamSessionId 键下（修复前挂 '' 键 → 空）
    const entries = store.listByStream('ws-j', cfg.streamSessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.streamSessionId).toBe(cfg.streamSessionId);
    // 关键断言：sessionId = cfg.executionSessionId（修复前 boot 空串归一为 null）
    expect(entries[0]?.sessionId).toBe(cfg.executionSessionId);
    expect(entries[0]?.taskId).toBe(cfg.taskId);
    expect(entries[0]?.op).toBe('create');
    expect(entries[0]?.toolName).toBe('write_file');

    // 空串键下零残留（修复前条目落此键——消息 chip 查询永不命中的直接病灶）
    expect(store.listByStream('ws-j', '')).toHaveLength(0);
    // boot ctx 不被回写（预 spawn 占位语义保持，per-run 变体不泄漏）
    expect(bootCtx.streamSessionId).toBe('');
    expect(bootCtx.roomId).toBe('');
  });

  it('dispatch 子任务（dispatchContext 设置）同样织入真实值（嵌套同源）', async () => {
    mockToolRoundRobin();
    const cfg = makeTaskConfig({
      streamSessionId: 'ssn-sub-real',
      executionSessionId: 'sess-sub-exec',
      body: '子任务写文件',
      dispatchContext: {
        fromAssignmentId: 'inst-pm',
        task_id: 'dispatch-1',
        tool_stream_session_id: 'ssn-pm',
      },
    });

    await runTaskChatLoop(cfg, makeConfig({ workspaceDir: tmpDir }), bootCtx);

    const entries = store.listByStream('ws-j', 'ssn-sub-real');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.streamSessionId).toBe('ssn-sub-real');
    expect(entries[0]?.sessionId).toBe('sess-sub-exec');
    expect(store.listByStream('ws-j', '')).toHaveLength(0);
  });
});
