// electron/tests/agent/abort-inflight-tool.test.ts
//
// abort 贯穿在途工具回归锁（spec 2026-11-19 abort-tool-inflight §6）。
// 用户实证（2026-11-19 Windows 导出库）：grep path:"." 在途时用户连点停止，
// 13 次 abortTurn 完成而回合不死 5 分钟——根因：chat loop 在途工具 Promise
// 只有自身抛 AbortError 才被识别，不监听 signal 的工具（grep 等）照跑到自然
// 返回；且中断退出不补 result → message_events 悬空 start → UI 悬转。
//
// 驱动方式（momo-test-rules——mock 只收窄到 LLM 边界，dispatch-parallel 同款）：
//   - 进程内真实 runChatLoop + 真实 abortListener（emitChildIpcMessage 注入
//     {type:'abort'}，与生产 child.send 同一消息面）
//   - 慢工具 = 真实 ToolModule（execute 返回永不 settle 的 Promise）——
//     「工具不监听 signal」的最小复现，不 mock executeTool 内部
//   - 断言：回合在守卫时限内终局 + 合成 tool_result 落 chunk 流 + 无 LLM 回填

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import type { StreamDelta } from '../../src/main/agent/llm-provider';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';
import type { ToolModule } from '../../src/main/agent/tools/types';
import type { RuntimeContext } from '../../src/main/agent/runtime-entry';

// 必须在 import runtime-entry 之前 mock（vi.mock hoist）
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

// mock electron：主进程合成 end chunk 走 stream-relay 推送（测试环境静默降级）
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import { runChatLoop, type RunChatLoopStats } from '../../src/main/agent/runtime-entry';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import { emitChildIpcMessage } from './child-ipc-sim';
import { AgentRunner } from '../../src/main/agent/agent-runner';
import { insertMessage } from '../../src/main/storage/messages/repo';
import { getMessageByStreamSessionId } from '../../src/main/storage/messages/repo';

const sentChunks: unknown[] = [];

function streamChunks(): StreamChunk[] {
  const types = new Set(['start', 'tool_call', 'tool_result', 'end', 'text']);
  return sentChunks.filter((c) => types.has((c as { type?: string }).type ?? '')) as StreamChunk[];
}

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

/** 慢工具模块：execute 永不 settle（「不监听 signal 的在途工具」最小复现） */
function slowToolModule(): ToolModule {
  return {
    getDefs: () => [
      { name: 'slow_tool', description: '永不返回', inputSchema: {} },
      { name: 'fast_tool', description: '立即返回', inputSchema: {} },
    ],
    getCatalog: () => [],
    handles: (n) => n === 'slow_tool' || n === 'fast_tool',
    execute: (n) =>
      n === 'slow_tool' ? new Promise<string>(() => {}) : Promise.resolve('快工具结果'),
  };
}

function makeConfig(): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-abort',
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
  };
}

function makeContext(): RuntimeContext {
  return {
    wsFs: {} as RuntimeContext['wsFs'],
    skillRegistry: { list: () => [], getIndex: () => '' } as unknown as RuntimeContext['skillRegistry'],
    tools: [],
    systemPrompt: 'You are a helpful assistant.',
    workspaceId: 'ws-1',
    workspaceDir: '/tmp/test',
    creatorUserId: '@owner:test',
    roomId: '!room:localhost',
    streamSessionId: 'test-session',
    sendStreamChunk: () => {},
    toolModules: [slowToolModule()],
  };
}

/** 回合终局守卫：spec §6.1 验收锚点——abort 后 ≤3s 终局（生产预算 5s 强杀，测试收紧） */
function withDeadline<T>(p: Promise<T>, ms = 3_000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`回合未在 ${ms}ms 内终局（在途工具未中断）`)), ms),
    ),
  ]);
}

describe('abort 贯穿在途工具（spec 2026-11-19 abort-tool-inflight）', () => {
  const originalSend = process.send;

  beforeEach(() => {
    runMigrations();
    sentChunks.length = 0;
    process.send = ((msg: unknown): boolean => {
      sentChunks.push(msg);
      return true;
    }) as NonNullable<typeof process.send>;
  });
  afterEach(() => {
    process.send = originalSend;
    closeDb();
  });

  it('慢工具（永不返回）在途 abort → 回合快速终局 + 合成 tool_result + end(interrupted)', async () => {
    mockProviderMultiRound([
      [
        { type: 'tool_use', toolCall: { id: 'c1', name: 'slow_tool', arguments: {} } },
        { type: 'done', finishReason: 'tool_use' },
      ],
    ]);
    const ctx = makeContext();
    const stats: RunChatLoopStats = { toolCallsUsed: 0 };

    const loop = runChatLoop('sess-abort-1', '跑慢工具', makeConfig(), ctx, stats);
    // 等 tool_call chip 发出（工具已 in-flight）再停——复现用户「工具在途点停止」
    await vi.waitFor(() => {
      expect(streamChunks().some((c) => c.type === 'tool_call')).toBe(true);
    });
    const startChunk = streamChunks().find((c) => c.type === 'start') as { streamSessionId: string };
    emitChildIpcMessage({ type: 'abort', streamSessionId: startChunk.streamSessionId });

    const result = await withDeadline(loop);

    expect(result).toBe('(中断)');
    expect(stats.aborted).toBe(true);
    // 合成 tool_result：悬空 start 不再出现（UI 聚合器可收敛）
    const res = streamChunks().find(
      (c) => c.type === 'tool_result' && (c as { callId?: string }).callId === 'c1',
    ) as { success: boolean; result: string };
    expect(res).toBeDefined();
    expect(res.success).toBe(false);
    expect(res.result).toContain('用户停止');
    const endChunk = streamChunks().find((c) => c.type === 'end') as { finishReason: string };
    expect(endChunk.finishReason).toBe('interrupted');
  });

  it('快工具已完成 + 慢工具在途 abort → 快工具保正常 result、慢工具合成（各一条不重复）', async () => {
    mockProviderMultiRound([
      [
        { type: 'tool_use', toolCall: { id: 'f1', name: 'fast_tool', arguments: {} } },
        { type: 'tool_use', toolCall: { id: 's1', name: 'slow_tool', arguments: {} } },
        { type: 'done', finishReason: 'tool_use' },
      ],
    ]);
    const ctx = makeContext();

    const loop = runChatLoop('sess-abort-2', '先快后慢', makeConfig(), ctx);
    await vi.waitFor(() => {
      expect(streamChunks().some((c) => c.type === 'tool_call' && (c as { callId?: string }).callId === 's1')).toBe(true);
    });
    const startChunk = streamChunks().find((c) => c.type === 'start') as { streamSessionId: string };
    emitChildIpcMessage({ type: 'abort', streamSessionId: startChunk.streamSessionId });

    await withDeadline(loop);

    const results = streamChunks().filter(
      (c) => c.type === 'tool_result',
    ) as Array<{ callId?: string; success: boolean; result: string }>;
    const fast = results.filter((r) => r.callId === 'f1');
    const slow = results.filter((r) => r.callId === 's1');
    expect(fast).toHaveLength(1);
    expect(fast[0]!.success).toBe(true);
    expect(fast[0]!.result).toBe('快工具结果');
    expect(slow).toHaveLength(1);
    expect(slow[0]!.success).toBe(false);
    expect(slow[0]!.result).toContain('用户停止');
  });
});


// ── 主进程 5s 强杀保底（spec §3.2）：race 快速路径失效（子进程僵死）时，
// abortStream 的兜底计时器给出确定性终局——合成 end(interrupted) 走完整落库
// 路径（messages → aborted）+ finalizeActiveTask（kill 子进程 + 池回收）。
describe('abortStream 5s 强杀保底（spec 2026-11-19 abort-tool-inflight §3.2）', () => {
  it('5s 未终局 → 合成 end(interrupted) 落库为 aborted + 强制回收 runner', async () => {
    // streaming 态 message 行（end chunk 落库的对象）
    insertMessage({
      sessionId: 'sess-force',
      sender: 'agent-inst-fk',
      eventType: 'text',
      body: '',
      streamSessionId: 's-force-1',
      status: 'streaming',
    });

    const released: string[] = [];
    const killed: boolean[] = [];
    const child = {
      pid: 4302,
      on: vi.fn(),
      off: vi.fn(),
      connected: true,
      exitCode: null,
      kill: () => {
        killed.push(true);
      },
      send: vi.fn(() => true),
    };
    const runner = new AgentRunner({
      agentAssignmentId: 'inst-fk',
      agentUserId: 'agent-inst-fk',
      workspaceId: 'ws-1',
      warmPool: {
        release: () => {
          released.push('s-force-1-runtime');
        },
      } as unknown as ConstructorParameters<typeof AgentRunner>[0]['warmPool'],
    });
    // 活跃表注入（生产由 runTask 写入；此处构造真实形状——强杀路径本身是被测对象）
    const task = {
      streamSessionId: 's-force-1',
      executionSessionId: 'sess-force',
      runtime: { child, spawnedAt: Date.now(), agentId: 'inst-fk' },
      taskId: null,
      startedAt: Date.now(),
      messageHandler: () => {},
    };
    (runner as unknown as { activeTasks: Map<string, unknown> }).activeTasks.set('s-force-1', task);

    vi.useFakeTimers();
    try {
      runner.abortStream('s-force-1');
      // abort IPC 已即时下发（safeSend 两参形态：msg + 异步失败 callback——子进程未响应模拟僵死）
      const sentCall = (child.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | { type?: string; streamSessionId?: string }
        | undefined;
      expect(sentCall).toMatchObject({ type: 'abort', streamSessionId: 's-force-1' });
      vi.advanceTimersByTime(5_000);
      // 5s 到点：合成 end → messages 终态 aborted；finalize → 池回收 + kill 链
      const msg = getMessageByStreamSessionId('s-force-1');
      expect(msg?.status).toBe('aborted');
      expect(released).toHaveLength(1);
      expect((runner as unknown as { activeTasks: Map<string, unknown> }).activeTasks.has('s-force-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    void killed;
  });

  it('期间正常收尾 → 到点自查 no-op（不误杀）', () => {
    const child = { pid: 1, on: vi.fn(), off: vi.fn(), connected: true, exitCode: null, kill: vi.fn(), send: vi.fn(() => true) };
    const runner = new AgentRunner({
      agentAssignmentId: 'inst-fk2',
      agentUserId: 'agent-inst-fk2',
      workspaceId: 'ws-1',
      warmPool: { release: vi.fn() } as unknown as ConstructorParameters<typeof AgentRunner>[0]['warmPool'],
    });
    vi.useFakeTimers();
    try {
      runner.abortStream('s-none'); // 无活跃流 → no-op（不抛错）
      vi.advanceTimersByTime(5_000);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    void child;
  });
});
