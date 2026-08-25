// electron/tests/agent/dispatch-parallel.test.ts
//
// v2 dispatch 同轮并发执行回归锁（docs/specs/2026-08-25-dispatch-parallel-design.md §9）。
//
// 驱动方式（momo-test-rules 保真度）：
//   - 只 mock 进程/LLM 边界：createLLMProvider（chatStream 预置轮次）+ process.send 拦截
//   - dispatch 回执经真实 handleTaskReply 驱动（resolve 真实 pendingReplies），
//     不 mock executeDispatch 内部；subStreamSessionId / task_id 均由真实实现生成
//
// 核心断言（串行实现必红 → 并发实现转绿）：
//   同一轮发出 2 个 dispatch 时，B 的派发事件必须先于 A 的回执结果被发出
//   （串行下 B 的 dispatch 事件根本不会在 A 回执前发出）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
import { handleTaskReply } from '../../src/main/agent/dispatch-wait';
import { buildToolRegistry } from '../../src/main/agent/tools';
import { formatDispatchHint } from '../../src/main/agent/prompt-hints';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

// MemoryProvider stub：空对话 + 无 task（与 runtime-stream.test.ts 同款）
const stubMemoryProvider: MemoryProvider = {
  getTaskContext: async () => null,
  getConversationContext: async () => ({ messages: [] }),
  getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
  getUserContext: async () => ({ preferences: [] }),
  getWorkspaceContext: async () => null,
};

// === Mock 状态 ===

const sentChunks: unknown[] = [];

/** 从 sentChunks 中过滤出流式 chunk（排除 momo-internal-event / audit 等 IPC 消息） */
function streamChunks(): StreamChunk[] {
  const types = new Set(['start', 'thinking', 'text', 'tool_call', 'tool_result', 'end']);
  return sentChunks.filter((c) => {
    const t = (c as { type?: string }).type;
    return t !== undefined && types.has(t);
  }) as StreamChunk[];
}

/** 构造 mock chatStream——每次调用返回下一个预置的 delta 序列（与 runtime-stream.test.ts 同款） */
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

// === 内部事件拦截 ===

interface ReplyPlan {
  /** 派发事件发出后延迟多少 ms 回执 */
  delayMs: number;
  body: string;
  toolCallsUsed?: number;
  /** failed 供「单成员失败不拖垮兄弟成员」用例（spec §12 #3） */
  status?: 'completed' | 'failed';
}

/**
 * 拦截 process.send：dispatch 内部事件按目标 assignmentId 的计划延迟回执
 * （经真实 handleTaskReply 驱动 pendingReplies——不 mock executeDispatch 内部）。
 * onSecondDispatch 在第 2 个 dispatch 事件发出时同步触发（并发中断用例的 abort 钩子）。
 * 返回 dispatched 数组（按发出顺序记录 dispatch_to），供断言。
 */
function installDispatchInterceptor(
  plans: Record<string, ReplyPlan>,
  onSecondDispatch?: () => void,
): string[] {
  const dispatched: string[] = [];
  process.send = ((msg: unknown): boolean => {
    const m = msg as {
      type?: string;
      eventType?: string;
      content?: { dispatch_to?: string; task_id?: string };
    };
    if (m?.type === 'momo-internal-event' && m.eventType === 'io.momo-studio.dispatch') {
      const target = m.content?.dispatch_to ?? '?';
      const taskId = m.content?.task_id;
      dispatched.push(target);
      const plan = plans[target];
      if (taskId && plan) {
        setTimeout(() => {
          handleTaskReply({
            task_id: taskId,
            body: plan.body,
            status: plan.status ?? 'completed',
            tool_calls_used: plan.toolCallsUsed ?? 0,
          });
        }, plan.delayMs);
      }
      if (dispatched.length === 2 && onSecondDispatch) onSecondDispatch();
    }
    sentChunks.push(msg);
    return true;
  }) as NonNullable<typeof process.send>;
  return dispatched;
}

/** sentChunks 中指定目标（dispatch_to）的 dispatch 内部事件下标；不存在返回 -1 */
function idxOfDispatchEvent(target: string): number {
  return sentChunks.findIndex(
    (c) =>
      (c as { type?: string }).type === 'momo-internal-event' &&
      (c as { content?: { dispatch_to?: string } }).content?.dispatch_to === target,
  );
}

/** sentChunks 中指定 callId 的 tool_call / tool_result chunk 下标；不存在返回 -1 */
function idxOfChunk(type: 'tool_call' | 'tool_result', callId: string): number {
  return sentChunks.findIndex(
    (c) => (c as { type?: string }).type === type && (c as { callId?: string }).callId === callId,
  );
}

/** 读取 chatStream 的各轮调用参数（messages / tools） */
function chatStreamCalls(): Array<{ messages: LLMMessage[]; tools?: unknown }> {
  const provider = vi.mocked(createLLMProvider).mock.results[0]!.value as {
    chatStream: ReturnType<typeof vi.fn>;
  };
  return provider.chatStream.mock.calls.map((call) => ({
    messages: call[0] as LLMMessage[],
    tools: call[1] as unknown,
  }));
}

// === Mock RuntimeConfig / RuntimeContext（与 runtime-stream.test.ts 同款） ===

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-bot',
    agentUserId: '@bot:localhost',
    teamSessionId: '!team:localhost',
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

/** main 角色 + 两个子 agent（researcher / writer）——dispatch 工具注册的前提 */
function makeMainConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return makeConfig({
    role: 'main',
    subAgents: [
      { slug: 'researcher', assignmentId: 'inst-researcher', description: '研究员' },
      { slug: 'writer', assignmentId: 'inst-writer', description: '撰稿人' },
    ],
    ...overrides,
  });
}

function makeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  const mockWsFs = {
    readFile: vi.fn().mockResolvedValue(Buffer.from('mock file content')),
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

// === 用例（spec §9） ===

describe('dispatch 同轮并发执行（spec 2026-08-25）', () => {
  const originalSend = process.send;

  beforeEach(() => {
    sentChunks.length = 0;
    vi.mocked(createLLMProvider).mockReset();
    __setMemoryProviderForTest(stubMemoryProvider);
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
  });

  it('同轮两个 dispatch 并发执行——B 的派发事件先于 A 的结果（串行实现必红）', async () => {
    const cA = { id: 'cA', name: 'dispatch:researcher', arguments: { task: 'A 任务' } };
    const cB = { id: 'cB', name: 'dispatch:writer', arguments: { task: 'B 任务' } };
    mockProviderMultiRound([
      [
        { type: 'tool_use', toolCall: cA },
        { type: 'tool_use', toolCall: cB },
        { type: 'done', finishReason: 'tool_use' },
      ],
      [{ type: 'text', content: '汇总完成' }, { type: 'done', finishReason: 'stop' }],
    ]);
    // A 慢（50ms）B 快（10ms）——并发下 B 的派发事件必须在 A 回执处理完成之前发出
    installDispatchInterceptor({
      'inst-researcher': { delayMs: 50, body: 'A 结果' },
      'inst-writer': { delayMs: 10, body: 'B 结果' },
    });

    await runChatLoop('!room:localhost', '并行查', makeMainConfig(), makeContext());

    expect(idxOfDispatchEvent('inst-writer')).toBeGreaterThanOrEqual(0);
    expect(idxOfDispatchEvent('inst-writer')).toBeLessThan(idxOfChunk('tool_result', 'cA'));
  });

  it('并发批次 chip 同时出现——两个 tool_call chunk 均先于任何 tool_result', async () => {
    const cA = { id: 'cA', name: 'dispatch:researcher', arguments: { task: 'A 任务' } };
    const cB = { id: 'cB', name: 'dispatch:writer', arguments: { task: 'B 任务' } };
    mockProviderMultiRound([
      [
        { type: 'tool_use', toolCall: cA },
        { type: 'tool_use', toolCall: cB },
        { type: 'done', finishReason: 'tool_use' },
      ],
      [{ type: 'text', content: '完成' }, { type: 'done', finishReason: 'stop' }],
    ]);
    installDispatchInterceptor({
      'inst-researcher': { delayMs: 50, body: 'A 结果' },
      'inst-writer': { delayMs: 10, body: 'B 结果' },
    });

    await runChatLoop('!room:localhost', '并行查', makeMainConfig(), makeContext());

    const firstResultIdx = Math.min(
      idxOfChunk('tool_result', 'cA'),
      idxOfChunk('tool_result', 'cB'),
    );
    expect(idxOfChunk('tool_call', 'cA')).toBeLessThan(firstResultIdx);
    expect(idxOfChunk('tool_call', 'cB')).toBeLessThan(firstResultIdx);
    // 完成顺序可见：B（10ms）的结果先于 A（50ms）
    expect(idxOfChunk('tool_result', 'cB')).toBeLessThan(idxOfChunk('tool_result', 'cA'));
  });

  it('消息回填按原 toolCalls 顺序——B 先完成仍排在 A 之后（协议 id 对应）', async () => {
    const cA = { id: 'cA', name: 'dispatch:researcher', arguments: { task: 'A 任务' } };
    const cB = { id: 'cB', name: 'dispatch:writer', arguments: { task: 'B 任务' } };
    mockProviderMultiRound([
      [
        { type: 'tool_use', toolCall: cA },
        { type: 'tool_use', toolCall: cB },
        { type: 'done', finishReason: 'tool_use' },
      ],
      [{ type: 'text', content: '完成' }, { type: 'done', finishReason: 'stop' }],
    ]);
    installDispatchInterceptor({
      'inst-researcher': { delayMs: 50, body: 'A 结果' },
      'inst-writer': { delayMs: 10, body: 'B 结果' },
    });

    await runChatLoop('!room:localhost', '并行查', makeMainConfig(), makeContext());

    const calls = chatStreamCalls();
    const toolMsgs = calls[1]!.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => (m as { toolCallId?: string }).toolCallId)).toEqual(['cA', 'cB']);
  });

  it('sub-budget 均分（D3）——budget=5 双 dispatch 各拿 3，追扣后预算耗尽', async () => {
    const cA = { id: 'cA', name: 'dispatch:researcher', arguments: { task: 'A 任务' } };
    const cB = { id: 'cB', name: 'dispatch:writer', arguments: { task: 'B 任务' } };
    mockProviderMultiRound([
      [
        { type: 'tool_use', toolCall: cA },
        { type: 'tool_use', toolCall: cB },
        { type: 'done', finishReason: 'tool_use' },
      ],
      [{ type: 'text', content: '完成' }, { type: 'done', finishReason: 'stop' }],
    ]);
    installDispatchInterceptor({
      'inst-researcher': { delayMs: 10, body: 'A 结果', toolCallsUsed: 3 },
      'inst-writer': { delayMs: 10, body: 'B 结果', toolCallsUsed: 3 },
    });

    await runChatLoop(
      '!room:localhost',
      '并行查',
      makeMainConfig({ maxToolCalls: 5 }),
      makeContext(),
    );

    const budgetOf = (target: string): unknown =>
      (
        sentChunks.find(
          (c) =>
            (c as { type?: string }).type === 'momo-internal-event' &&
            (c as { content?: { dispatch_to?: string } }).content?.dispatch_to === target,
        ) as { content?: { tool_budget?: unknown } } | undefined
      )?.content?.tool_budget;
    // 段前 5 - 段长 2 = 3：两个成员均分拿到 3（串行实现为先到先得 4/3，必红）
    expect(budgetOf('inst-researcher')).toBe(3);
    expect(budgetOf('inst-writer')).toBe(3);
    // 5 - 2（段预扣）- 3 - 3（回执追扣）= -3 ≤ 0 → 第二轮不带工具
    expect(chatStreamCalls()[1]!.tools).toBeUndefined();
  });

  it('预算不足截断——budget=1 段长 2 只发 1 个 + budget_exhausted，被截成员无 chip', async () => {
    const cA = { id: 'cA', name: 'dispatch:researcher', arguments: { task: 'A 任务' } };
    const cB = { id: 'cB', name: 'dispatch:writer', arguments: { task: 'B 任务' } };
    mockProviderMultiRound([
      [
        { type: 'tool_use', toolCall: cA },
        { type: 'tool_use', toolCall: cB },
        { type: 'done', finishReason: 'tool_use' },
      ],
      [{ type: 'text', content: '完成' }, { type: 'done', finishReason: 'stop' }],
    ]);
    const dispatched = installDispatchInterceptor({
      'inst-researcher': { delayMs: 10, body: 'A 结果' },
      'inst-writer': { delayMs: 10, body: 'B 结果' },
    });

    const result = await runChatLoop(
      '!room:localhost',
      '并行查',
      makeMainConfig({ maxToolCalls: 1 }),
      makeContext(),
    );

    expect(dispatched).toEqual(['inst-researcher']);
    expect(idxOfChunk('tool_call', 'cB')).toBe(-1);
    const endChunk = streamChunks().find((c) => c.type === 'end') as { finishReason: string };
    expect(endChunk.finishReason).toBe('budget_exhausted');
    expect(result).toBe('(工具预算耗尽)');
  });

  it('并发批次中断——两成员均中断、无 tool_result 回填、end(interrupted)', async () => {
    const cA = { id: 'cA', name: 'dispatch:researcher', arguments: { task: 'A 任务' } };
    const cB = { id: 'cB', name: 'dispatch:writer', arguments: { task: 'B 任务' } };
    mockProviderMultiRound([
      [
        { type: 'tool_use', toolCall: cA },
        { type: 'tool_use', toolCall: cB },
        { type: 'done', finishReason: 'tool_use' },
      ],
      [{ type: 'text', content: '完成' }, { type: 'done', finishReason: 'stop' }],
    ]);
    // 回执 500ms 不会到达——abort 在第 2 个派发事件发出时同步触发（先于任何回执）
    installDispatchInterceptor(
      {
        'inst-researcher': { delayMs: 500, body: 'A 结果' },
        'inst-writer': { delayMs: 500, body: 'B 结果' },
      },
      () => {
        // 模拟主进程 IPC 下发 abort（与 runtime-stream.test.ts abort 用例同款触发方式）
        const startChunk = streamChunks().find((c) => c.type === 'start') as {
          streamSessionId: string;
        };
        for (const listener of process.listeners('message')) {
          listener({ type: 'abort', streamSessionId: startChunk.streamSessionId }, undefined);
        }
      },
    );

    const result = await runChatLoop('!room:localhost', '并行查', makeMainConfig(), makeContext());

    expect(result).toBe('(中断)');
    // 中断不回填任何 tool result（防「中断-重试」死循环，spec §6.1）
    expect(idxOfChunk('tool_result', 'cA')).toBe(-1);
    expect(idxOfChunk('tool_result', 'cB')).toBe(-1);
    const endChunk = streamChunks().find((c) => c.type === 'end') as { finishReason: string };
    expect(endChunk.finishReason).toBe('interrupted');
  });

  it('单成员失败不拖垮兄弟成员——A 回 failed、B 正常完成（spec §12 #3）', async () => {
    const cA = { id: 'cA', name: 'dispatch:researcher', arguments: { task: 'A 任务' } };
    const cB = { id: 'cB', name: 'dispatch:writer', arguments: { task: 'B 任务' } };
    mockProviderMultiRound([
      [
        { type: 'tool_use', toolCall: cA },
        { type: 'tool_use', toolCall: cB },
        { type: 'done', finishReason: 'tool_use' },
      ],
      [{ type: 'text', content: '完成' }, { type: 'done', finishReason: 'stop' }],
    ]);
    installDispatchInterceptor({
      'inst-researcher': { delayMs: 10, body: 'A 失败原因', status: 'failed' },
      'inst-writer': { delayMs: 50, body: 'B 结果' },
    });

    await runChatLoop('!room:localhost', '并行查', makeMainConfig(), makeContext());

    // A 失败：失败 chip + 失败文案回填；B 不受影响：成功 chip
    const resultOf = (callId: string): { success: boolean; subStatus?: string } =>
      sentChunks[idxOfChunk('tool_result', callId)] as { success: boolean; subStatus?: string };
    expect(resultOf('cA')).toMatchObject({ success: false, subStatus: 'failed' });
    expect(resultOf('cB')).toMatchObject({ success: true, subStatus: 'completed' });
    // 失败属非 abort 错误——回填按原序保留两条 tool 消息，A 的内容含失败原因
    const calls = chatStreamCalls();
    const toolMsgs = calls[1]!.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => (m as { toolCallId?: string }).toolCallId)).toEqual(['cA', 'cB']);
    expect((toolMsgs[0] as { content: string }).content).toContain('A 失败原因');
    // chat loop 正常收敛到 stop（非 interrupted / budget_exhausted）
    const endChunk = streamChunks().find((c) => c.type === 'end') as { finishReason: string };
    expect(endChunk.finishReason).toBe('stop');
  });

  it('混排——dispatch / read_file / dispatch 各自原位，read_file 串行保序', async () => {
    const cA = { id: 'cA', name: 'dispatch:researcher', arguments: { task: 'A 任务' } };
    const cR = { id: 'cR', name: 'read_file', arguments: { path: 'a.txt' } };
    const cB = { id: 'cB', name: 'dispatch:writer', arguments: { task: 'B 任务' } };
    mockProviderMultiRound([
      [
        { type: 'tool_use', toolCall: cA },
        { type: 'tool_use', toolCall: cR },
        { type: 'tool_use', toolCall: cB },
        { type: 'done', finishReason: 'tool_use' },
      ],
      [{ type: 'text', content: '完成' }, { type: 'done', finishReason: 'stop' }],
    ]);
    installDispatchInterceptor({
      'inst-researcher': { delayMs: 10, body: 'A 结果' },
      'inst-writer': { delayMs: 10, body: 'B 结果' },
    });

    await runChatLoop('!room:localhost', '混合任务', makeMainConfig(), makeContext());

    // 两段各长 1（A 单独一段、B 单独一段），read_file 原位串行——回填顺序不变
    const calls = chatStreamCalls();
    const toolMsgs = calls[1]!.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => (m as { toolCallId?: string }).toolCallId)).toEqual([
      'cA',
      'cR',
      'cB',
    ]);
    for (const callId of ['cA', 'cR', 'cB']) {
      const idx = idxOfChunk('tool_result', callId);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect((sentChunks[idx] as { success?: boolean }).success).toBe(true);
    }
  });

  it('重复检测在段内截断——3 个相同 dispatch 执行 2 个后终止', async () => {
    const mk = (id: string): { id: string; name: string; arguments: Record<string, unknown> } => ({
      id,
      name: 'dispatch:researcher',
      arguments: { task: '同一任务' },
    });
    mockProviderMultiRound([
      [
        { type: 'tool_use', toolCall: mk('c1') },
        { type: 'tool_use', toolCall: mk('c2') },
        { type: 'tool_use', toolCall: mk('c3') },
        { type: 'done', finishReason: 'tool_use' },
      ],
      [{ type: 'text', content: '完成' }, { type: 'done', finishReason: 'stop' }],
    ]);
    const dispatched = installDispatchInterceptor({
      'inst-researcher': { delayMs: 10, body: 'ok' },
    });

    const result = await runChatLoop('!room:localhost', '重复任务', makeMainConfig(), makeContext());

    // 第 3 个成员在段扫描时命中重复检测（窗口内同签名计数 = 3）→ 段截断为前 2 个
    expect(dispatched).toEqual(['inst-researcher', 'inst-researcher']);
    const endChunk = streamChunks().find((c) => c.type === 'end') as { finishReason: string };
    expect(endChunk.finishReason).toBe('stop');
    expect(result).toContain('重复');
  });
});

describe('formatDispatchHint 并行教学（spec §7.2）', () => {
  it('main + 有 subAgents → 含同轮连发并行教学', () => {
    const hint = formatDispatchHint(makeMainConfig());
    expect(hint).toContain('同一次回复中连续发出多个 dispatch');
    expect(hint).toContain('并行执行');
  });

  it('非 main / 无 subAgents → 空串（standalone 不受影响）', () => {
    expect(formatDispatchHint(makeConfig())).toBe('');
  });

  it('main 但 subAgents 为空 → 空串（OR 早退条件的另一半）', () => {
    expect(formatDispatchHint(makeConfig({ role: 'main' }))).toBe('');
  });
});

describe('pm-agent.yaml 并行教学文案（spec §7.1）', () => {
  it('builtin PM systemPrompt 含同轮连发并发执行语义', () => {
    const yamlPath = path.join(__dirname, '..', '..', 'resources', 'agents', 'pm-agent.yaml');
    const yaml = readFileSync(yamlPath, 'utf-8');
    expect(yaml).toContain('在同一次回复中连续发出多个 dispatch 工具调用');
    expect(yaml).toContain('它们会被并发执行');
  });
});
