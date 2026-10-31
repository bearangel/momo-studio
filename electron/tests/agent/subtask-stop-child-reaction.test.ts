// electron/tests/agent/subtask-stop-child-reaction.test.ts
//
// D3 复现红测·段 5（验收报告 2026-10-31 T15：「停止 Smith 的子任务」点击后 7 分钟
// 无效）。五段插桩定位法的最后一段：子 agent 运行时对 {type:'abort'} IPC 的反应。
//
// 段 1-4（cancelChain → broadcastAbortDispatch → runners Map → activeTasks →
// child.send）已由 interrupt-cascade-e2e 场景 1 锁绿（mock 壳只捕获不反应——
// 反应域恰是本文件要锁的空白）。
//
// 保真边界（momo-test-rules）：mock 只落在 fetch 网络边界——llm-provider 真实
// 实现（含 abort race 与 D2 看门狗）、runChatLoop 真实现、abortListener 真实现。
// 死流形态 = 报告病理：建连成功 + 下发一条 thinking delta 后**静默**（无 FIN/RST，
// read 永不返回）——与 T14「出站 socket 已消失而 UI 计时器持续」同构。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// mock electron：stream-relay 的 BrowserWindow 推送在测试环境静默降级
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

// 注意：本文件【不】mock llm-provider——被测面正是真实 provider 的 abort 语义
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { runChatLoop, type RuntimeContext } from '../../src/main/agent/runtime-entry';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';
import { buildToolRegistry } from '../../src/main/agent/tools';
import { emitChildIpcMessage } from './child-ipc-sim';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

const stubMemoryProvider: MemoryProvider = {
  getTaskContext: async () => null,
  getConversationContext: async () => ({ messages: [] }),
  getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
  getUserContext: async () => ({ preferences: [] }),
  getWorkspaceContext: async () => null,
  getPinnedContext: async () => ({ hint: '', truncatedCount: 0, pinnedIds: [] }),
  searchMemories: async () => {
    throw new Error('测试 stub 不落库');
  },
  saveMemory: async () => {
    throw new Error('测试 stub 不落库');
  },
  deleteMemory: async () => {
    throw new Error('测试 stub 不落库');
  },
};

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-subtask-stop-react-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const sentMsgs: unknown[] = [];
const originalSend = process.send;
let sessChatId = '';

function streamChunks(): StreamChunk[] {
  const types = new Set(['start', 'thinking', 'text', 'tool_call', 'tool_result', 'end']);
  return sentMsgs.filter((c) => {
    const t = (c as { type?: string }).type;
    return t !== undefined && types.has(t);
  }) as StreamChunk[];
}

function makeConfig(): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-smith',
    agentUserId: 'agent-inst-smith',
    systemPrompt: 'x',
    modelName: 'm',
    llmApiKey: 'k',
    workspaceDir: '/tmp',
    workspaceId: 'ws',
    role: 'main',
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
  };
}

function makeContext(streamSessionId: string): RuntimeContext {
  const mockWsFs = {
    readFile: vi.fn().mockResolvedValue(Buffer.from('mock file content')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    listDir: vi.fn().mockResolvedValue([]),
    assertInWorkspace: (p: string) => path.resolve('/tmp', p),
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
    workspaceId: 'ws',
    workspaceDir: '/tmp',
    creatorUserId: '@owner:test',
    roomId: sessChatId,
    streamSessionId,
    sendStreamChunk: () => {},
    toolModules: buildToolRegistry({
      wsFs: mockWsFs,
      workspaceId: 'ws',
      workspaceDir: '/tmp',
      creatorUserId: '@owner:test',
      skillRegistry: mockSkillRegistry,
      streamSessionId,
      roomId: sessChatId,
      sendStreamChunk: () => {},
      permissionConfig: { allowedTools: [] as string[], deniedTools: [] as string[] },
    }),
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`,
  ).run();
  const sess = insertSession({ workspaceId: 'ws', title: 'subtask-stop-react' });
  sessChatId = sess.id;
  __setMemoryProviderForTest(stubMemoryProvider);
  sentMsgs.length = 0;
  process.send = ((msg: unknown): boolean => {
    sentMsgs.push(msg);
    return true;
  }) as NonNullable<typeof process.send>;
});

afterEach(async () => {
  process.send = originalSend;
  __resetMemoryProviderForTest();
  await new Promise((resolve) => setTimeout(resolve, 50));
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
  vi.unstubAllGlobals();
});

describe('D3 段 5：真实子运行时对 abort IPC 的反应（死流形态）', () => {
  it('thinking 后静默的死流中注入 abort → 回合秒级 (中断)/interrupted（不再挂死 7 分钟）', async () => {
    const enc = new TextEncoder();
    // 报告病理形态：一条 thinking delta 后 socket 黑洞（无数据、无 FIN、无 RST）
    const deadStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          enc.encode('data: {"choices":[{"delta":{"reasoning_content":"开始思考长任务"}}]}\n\n'),
        );
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(deadStream, { headers: { 'content-type': 'text/event-stream' } })),
    );

    const ssi = 'ss-smith-dead';
    // 第 9 参 streamSessionIdOverride：runChatLoop 流 id 优先级 override > parent > randomUUID——
    // 注入的 abort 按它精确匹配（interrupt-cascade 同款纪律）
    const loopDone = runChatLoop(sessChatId, '写一个完整游戏', makeConfig(), makeContext(ssi), undefined, undefined, undefined, ssi);

    // 思考 delta 已产出（证明已阻塞在死流读循环中，而非尚未建连）
    await vi.waitFor(
      () => {
        expect(streamChunks().some((c) => c.type === 'thinking')).toBe(true);
      },
      { timeout: 3000 },
    );

    // 用户点击「停止 Smith 的子任务」→ 主进程 abortStream → child.send（本进程内
    // 以同款 IPC 消息注入——与 dispatch-parallel「并发批次中断」同触发方式）
    emitChildIpcMessage({ type: 'abort', streamSessionId: ssi });

    // 若 abort 反应链断裂：loop 永不落幕 → 本用例超时红（正是报告的 7 分钟无效）。
    // 普通回合（非 dispatch 等待）的 abort 终态 = 空终文 + end(interrupted)
    const result = await loopDone;
    expect(result).toBe('');
    const endChunk = streamChunks().find((c) => c.type === 'end') as { finishReason: string };
    expect(endChunk.finishReason).toBe('interrupted');
  });
});
