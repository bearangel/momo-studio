# Dispatch 同轮并发执行 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PM 的 LLM 在同一次回复中发出 N 个 `dispatch:*` 工具调用时并发执行，回执按原顺序回填（依据 spec `docs/specs/2026-08-25-dispatch-parallel-design.md`）。

**Architecture:** 只改 PM 子进程 chat loop 的工具执行段（runtime-entry.ts）——`for...of` 逐个 await 重构为游标推进三段式：预检逐位原顺序 → 非 dispatch 工具原路径串行 → 极大连续 dispatch 段 `Promise.allSettled` 并发。预算段前预扣、sub-budget 均分、消息按原顺序回填。协议/主进程/renderer 零改动。

**Tech Stack:** TypeScript strict（Electron 主进程 CommonJS）、Vitest、pnpm workspace。

## Global Constraints

- Node 20：容器默认 Node 26，所有命令前先 `nvm use 20`
- pnpm 一律 `npx pnpm@9.0.0`
- TypeScript strict：禁止 `any` / `@ts-ignore` / `as any`（ESLint `no-explicit-any: error`）
- 所有代码注释使用中文；标识符英文
- Conventional Commits，中文描述（如 `feat(agent): ...`）
- **契约零改动**（spec §8）：不改 `StreamChunk` / `DispatchContent` / `TaskReplyContent` / IPC 通道 / preload / renderer 任何文件
- **测试保真度**（momo-test-rules）：只 mock 进程/LLM 边界（`process.send` / `createLLMProvider`）；dispatch 回执经真实 `handleTaskReply` 驱动，不 mock `executeDispatch` 内部；UUID 由真实实现生成
- 每个 Task 结束必须跑对应验证命令，绿了才 commit

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `electron/tests/agent/dispatch-parallel.test.ts` | 并发回归锁（8 用例）+ prompt 教学断言 | 新建（Task 1、Task 3 追加） |
| `electron/src/main/agent/runtime-entry.ts` | chat loop 工具执行段重构 + `execDispatchCall` 闭包 | 修改（Task 2） |
| `electron/src/main/agent/prompt-hints.ts` | `formatDispatchHint` 新增并行教学条目 | 修改（Task 3） |
| `electron/resources/agents/pm-agent.yaml` | builtin PM prompt 文案修正 | 修改（Task 3） |

---

### Task 1: 并发回归锁——新测试文件（红）

**Files:**
- Create: `electron/tests/agent/dispatch-parallel.test.ts`

**Interfaces:**
- Consumes: `runChatLoop(roomId, body, config, ctx, stats?, parentStreamSessionId?, externalAbortSignal?, streamSessionIdOverride?)`（runtime-entry.ts 导出，签名不变）；`handleTaskReply(content)`（dispatch-wait.ts 导出）；`formatDispatchHint(config)`（Task 3 追加使用）
- Produces: 测试 harness 函数 `makeMainConfig()` / `installDispatchInterceptor(plans, onSecondDispatch?)` / `idxOfDispatchEvent(target)` / `idxOfChunk(type, callId)` / `chatStreamCalls()`——Task 3 的追加用例复用

**背景（给零上下文工程师）**：`runChatLoop` 是 agent 子进程的 LLM 对话循环。LLM 一轮可返回多个工具调用（`toolCalls` 数组）；现状是对其 `for...of` 逐个 `await`，其中 `dispatch:<slug>` 工具执行时会向主进程发内部事件（经 `process.send` 的 `momo-internal-event` 信封，`eventType === 'io.momo-studio.dispatch'`）并阻塞等待子 agent 回执（回执由 `handleTaskReply` 按 `task_id` resolve pending Promise）。本测试验证并发化后：同一轮的多个 dispatch 事件在任一回执到达前全部发出。串行实现下测试 1/2/4/6 必红（这是回归锁的意义），3/5/7/8 是行为不变的基线锁。

- [ ] **Step 1: 写测试文件（完整内容如下）**

```typescript
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
            status: 'completed',
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
```

- [ ] **Step 2: 跑测试确认红（预期 4 红 4 绿）**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/dispatch-parallel.test.ts`
Expected: **4 failed**（并发性 / chip 同时出现 / sub-budget 均分 / 批次中断），**4 passed**（回填顺序 / 预算截断 / 混排 / 重复检测——这四个是行为不变基线，串行下即绿）。若 8 个全红或全绿，先停下核对 harness 与断言，不要继续。

- [ ] **Step 3: Commit**

```bash
git add electron/tests/agent/dispatch-parallel.test.ts
git commit -m "test(agent): dispatch 同轮并发回归锁——8 用例先行（4 红锁并发语义 / 4 绿锁行为基线）"
```

---

### Task 2: runChatLoop 工具循环三段式重构（绿）

**Files:**
- Modify: `electron/src/main/agent/runtime-entry.ts`（工具执行段 :409-660 + 新增 `execDispatchCall` 闭包）

**Interfaces:**
- Consumes: Task 1 的测试文件（验收标准）
- Produces: `execDispatchCall(tc, subBudget, dispatchInfo): Promise<string>`（runChatLoop 内部闭包，非导出）；行为契约见 spec §4-§6

**实现要点**（spec §4，给零上下文工程师）：
- 现状：`for (const tc of toolCalls)` 内对每个工具逐个 `await executeTool(...)`；`dispatch:*` 工具的执行体 = 发增强 tool_call chunk → `executeTool`（内部 `executeDispatch` 发内部事件并阻塞等 task_reply）→ 发 tool_result chunk。
- 目标：保持非 dispatch 工具与全部预检逐位不变；把「极大连续 dispatch 段」改为一次 `Promise.allSettled` 并发。
- 关键不变量：① 消息回填按原 toolCalls 顺序（协议要求 tool 消息与 assistant.toolCalls 的 id 一一对应）；② 中断时全部成员统一退出且不回填；③ 段长 1 时 sub-budget 公式与串行逐位一致（`budgetBefore - 1`）；④ 被截断成员不发 tool_call chunk。

- [ ] **Step 1: 在 `sendEndChunk` 定义之后（现 :315 行后）、`for (let round = 0; ; round++)` 之前插入 `execDispatchCall` 闭包**

```typescript
  /**
   * v2 dispatch 并行（docs/specs/2026-08-25-dispatch-parallel-design.md §4.1）：
   * 单个 dispatch 工具调用的执行体——并发批次的成员。
   * 同步段：预生成 subStreamSessionId + 发 tool_call chip（批次启动时 K 个 chip 即刻全部出现，
   *   P0-7 查找键语义不变——renderer DispatchChip 据此关联子流）。
   * 异步段：executeTool（内部 executeDispatch 发内部事件等 task_reply）→ settle 时发 tool_result chip。
   * 非 abort 错误转 result 字符串返回（allSettled 不短路，LLM 下一轮可见自行纠正，与串行语义一致）；
   * abort 错误原样 reject（批次边界统一走中断退出，不回填 tool result——防「中断-重试」死循环）。
   */
  const execDispatchCall = (
    tc: LLMToolCall,
    /** 段级均分 sub-budget（D3）：段前预算 - 段长；-1 = 无限 */
    subBudget: number,
    /** 本成员独立的回执计数（§6.3 禁止跨成员共享对象，预算追扣据此） */
    dispatchInfo: { toolCallsUsed: number },
  ): Promise<string> => {
    const subStreamSessionId = randomUUID();
    const subSlug = tc.name.slice('dispatch:'.length);
    const subRef = config.subAgents.find((s) => s.slug === subSlug);
    const subAgentName = subRef?.description ?? subRef?.slug ?? tc.name;
    sendStreamChunk({
      type: 'tool_call',
      streamSessionId,
      callId: tc.id,
      toolName: tc.name,
      args: tc.arguments,
      isDispatch: true,
      subStreamSessionId,
      subAgentName,
      subAgentAvatar: '🤖',
    });
    return executeTool(tc, ctx, config, subBudget, dispatchInfo, subStreamSessionId, streamSessionId, roomId)
      .then((result) => {
        sendStreamChunk({
          type: 'tool_result',
          streamSessionId,
          callId: tc.id,
          toolName: tc.name,
          result,
          success: true,
          subStatus: 'completed' as const,
        });
        return result;
      })
      .catch((err: unknown) => {
        if ((err as Error).name === 'AbortError' || abortController.signal.aborted) throw err;
        const errMsg = err instanceof Error ? err.message : String(err);
        const result = `工具执行失败: ${errMsg}`;
        // dispatch 超时（executeDispatch 渐进式计时器 reject）→ 'timeout'；其它 → 'failed'
        const subStatus = errMsg.includes('超时') ? ('timeout' as const) : ('failed' as const);
        sendStreamChunk({
          type: 'tool_result',
          streamSessionId,
          callId: tc.id,
          toolName: tc.name,
          result,
          success: false,
          subStatus,
        });
        return result;
      });
  };
```

- [ ] **Step 2: 把 `for (const tc of toolCalls) {`（现 :409）改为游标 while，预检块原样入循环**

将：

```typescript
    for (const tc of toolCalls) {
```

替换为：

```typescript
    // v2 dispatch 并行（spec §4）：游标推进三段式。
    //   ① 预检逐位原顺序（重复检测 / 预算耗尽 / task_complete / compact 内联处理）
    //   ② 非 dispatch 工具：原路径串行执行（零行为差异）
    //   ③ 极大连续 dispatch 段：一次 Promise.allSettled 并发（段长 1 行为与原路径逐位一致）
    let ti = 0;
    while (ti < toolCalls.length) {
      const tc = toolCalls[ti]!;
```

其后紧跟的**重复检测块（原注释 + `const sig = ...` 到 `}` 为止）与预算耗尽块（`if (budgetRemaining <= 0) {...}`）保持逐字不变**（两者内部的 `return` 语义在 while 中同样成立）。

- [ ] **Step 3: task_complete / compact 两块内联处理逻辑保持逐字不变，仅改各自结尾的循环推进**

- task_complete 块（现 :437-499）：内部唯一 `continue;`（现 :498）改为 `ti++; continue;`
- compact 块（现 :504-564）：两处 `continue;`（现 :520、:563）都改为 `ti++; continue;`

其余逻辑（分段持久化 / 消息 push / `toolCallCount++` / `budgetRemaining--`）逐字保留。

- [ ] **Step 4: 用下面的段处理 + 串行路径，替换 dispatch 分支与串行工具路径（现 :566-659 整段）**

删除现 :566-659（`const isDispatch = ...` 到 `messages.push({ role: 'tool', ... });`），替换为：

```typescript
      if (tc.name.startsWith('dispatch:')) {
        // === ③ dispatch 段：向后扫描极大连续 dispatch 段（spec §4.3 截断规则） ===
        // 段内逐位预检（原顺序）：重复检测截断 / 预算截断——被截断的成员不发 tool_call chip
        let segEnd = ti + 1;
        let exitAfterSegment: { finishReason: 'stop' | 'budget_exhausted'; fallbackText: string } | null = null;
        while (segEnd < toolCalls.length && toolCalls[segEnd]!.name.startsWith('dispatch:')) {
          const next = toolCalls[segEnd]!;
          const nextSig = `${next.name}:${JSON.stringify(next.arguments)}`;
          recentToolCallSignatures.push(nextSig);
          if (recentToolCallSignatures.length > MAX_DUPLICATE_TOOLS) {
            recentToolCallSignatures.shift();
          }
          const nextDup = recentToolCallSignatures.filter((s) => s === nextSig).length;
          if (nextDup >= MAX_DUPLICATE_TOOLS) {
            exitAfterSegment = {
              finishReason: 'stop',
              fallbackText: `(检测到连续 ${MAX_DUPLICATE_TOOLS} 次重复操作 ${next.name}，已强制终止防循环)`,
            };
            break;
          }
          // 纳入本成员后段长 = segEnd - ti + 1，须 ≤ 剩余预算；否则截断（§4.3）
          if (budgetRemaining !== Infinity && budgetRemaining < segEnd - ti + 1) {
            exitAfterSegment = { finishReason: 'budget_exhausted', fallbackText: '(工具预算耗尽)' };
            break;
          }
          segEnd++;
        }

        const seg = toolCalls.slice(ti, segEnd);
        const budgetBeforeSegment = budgetRemaining;
        // 段开始一次性预扣 K（spec §5.2）
        if (budgetRemaining !== Infinity) {
          budgetRemaining -= seg.length;
        }
        // D3 均分：并发无法预知各成员消耗，sub-budget 统一 = 段前预算 - 段长
        // （串行为先到先得；段长 1 时与串行公式 budgetRemaining - 1 逐位一致）
        const subBudget =
          budgetBeforeSegment === Infinity ? -1 : Math.max(0, budgetBeforeSegment - seg.length);
        const dispatchInfos = seg.map(() => ({ toolCallsUsed: 0 }));

        // 并发执行（§4.1）：execDispatchCall 同步段先发全部 K 个 tool_call chip，再各自等回执
        const settled = await Promise.allSettled(
          seg.map((member, idx) => execDispatchCall(member, subBudget, dispatchInfos[idx]!)),
        );

        // 中断（§6.1）：任一成员 AbortError / 信号已触发 → 统一中断退出，不回填 tool result
        // （与原串行 catch 分支语义一致，防「中断-重试」死循环）
        if (abortController.signal.aborted || settled.some((r) => r.status === 'rejected')) {
          process.off('message', abortListener);
          const finalText = accumulatedText.trim() || '(中断)';
          sendEndChunk({ type: 'end', streamSessionId, finishReason: 'interrupted' });
          if (stats) {
            stats.toolCallsUsed = toolCallCount;
            stats.aborted = true;
          }
          return finalText;
        }

        // 消息回填（§4.2）：按原 toolCalls 顺序（协议要求与 assistant.toolCalls 的 id 一一对应，
        // 不按完成顺序）；预算按各成员回执追扣（§5.2）
        for (let idx = 0; idx < seg.length; idx++) {
          const r = settled[idx] as PromiseFulfilledResult<string>;
          messages.push({ role: 'tool', content: r.value, toolCallId: seg[idx]!.id });
          toolCallCount++;
          const info = dispatchInfos[idx]!;
          if (info.toolCallsUsed > 0 && budgetRemaining !== Infinity) {
            budgetRemaining -= info.toolCallsUsed;
          }
        }

        // 段内截断（§4.3）：已执行成员的回执已发，按截断原因退出
        if (exitAfterSegment) {
          process.off('message', abortListener);
          const finalText = accumulatedText.trim() || exitAfterSegment.fallbackText;
          sendEndChunk({ type: 'end', streamSessionId, finishReason: exitAfterSegment.finishReason });
          if (stats) stats.toolCallsUsed = toolCallCount;
          return finalText;
        }

        ti = segEnd;
        continue;
      }

      // === ② 非 dispatch 工具：原路径串行执行（v2 并行仅作用于连续 dispatch 段） ===
      sendStreamChunk({
        type: 'tool_call',
        streamSessionId,
        callId: tc.id,
        toolName: tc.name,
        args: tc.arguments,
      });

      let result: string;
      try {
        result = await executeTool(tc, ctx, config, undefined, undefined, undefined, streamSessionId, roomId);
        sendStreamChunk({
          type: 'tool_result',
          streamSessionId,
          callId: tc.id,
          toolName: tc.name,
          result,
          success: true,
        });
      } catch (err) {
        // v1.5.2: 工具因 abort 失败立即跳出整个 chat loop，不推 tool_result 给 LLM
        // （否则 LLM 看到失败结果后重试，形成「中断-重试-中断」死循环）
        if ((err as Error).name === 'AbortError' || abortController.signal.aborted) {
          process.off('message', abortListener);
          const finalText = accumulatedText.trim() || '(中断)';
          sendEndChunk({ type: 'end', streamSessionId, finishReason: 'interrupted' });
          if (stats) {
            stats.toolCallsUsed = toolCallCount;
            stats.aborted = true;
          }
          return finalText;
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        result = `工具执行失败: ${errMsg}`;
        sendStreamChunk({
          type: 'tool_result',
          streamSessionId,
          callId: tc.id,
          toolName: tc.name,
          result,
          success: false,
        });
      }

      toolCallCount++;
      budgetRemaining--;
      messages.push({ role: 'tool', content: result, toolCallId: tc.id });
      ti++;
    }
```

注意：替换段的最后一行 `ti++;` 后的 `}` 闭合 while（对应原 for 的闭合 `}`，原 :660）。

- [ ] **Step 5: 跑新测试确认全绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/dispatch-parallel.test.ts`
Expected: **8 passed**

- [ ] **Step 6: 跑全部既有 dispatch / runtime 相关套件确认零回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-stream.test.ts tests/agent/runtime-segment.test.ts tests/agent/runtime-entry-routing.test.ts tests/agent/dispatch-fresh-session.test.ts tests/agent/dispatch-wait.test.ts tests/agent/runtime-task-driven.test.ts`
Expected: 全部 passed（这些套件覆盖单 dispatch 路径 = 段长 1 回归、abort、预算、分段）

- [ ] **Step 7: typecheck**

Run: `npx pnpm@9.0.0 typecheck`
Expected: electron + renderer 双 clean

- [ ] **Step 8: Commit**

```bash
git add electron/src/main/agent/runtime-entry.ts
git commit -m "feat(agent): dispatch 同轮并发执行——chat loop 连续段并发 / 预算预扣均分 / 回填保序"
```

---

### Task 3: Prompt 同轮连发教学（spec §7）

**Files:**
- Modify: `electron/resources/agents/pm-agent.yaml:25`
- Modify: `electron/src/main/agent/prompt-hints.ts`（formatDispatchHint）
- Test: `electron/tests/agent/dispatch-parallel.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `makeMainConfig()` / `makeConfig()` harness
- Produces: `formatDispatchHint` 输出含「同一次回复中连续发出多个 dispatch」教学文案（对全部自定义 main agent 生效）

- [ ] **Step 1: 追加失败测试到 `dispatch-parallel.test.ts` 文件末尾**

文件顶部 import 区追加：

```typescript
import { formatDispatchHint } from '../../src/main/agent/prompt-hints';
```

文件末尾追加：

```typescript
describe('formatDispatchHint 并行教学（spec §7.2）', () => {
  it('main + 有 subAgents → 含同轮连发并行教学', () => {
    const hint = formatDispatchHint(makeMainConfig());
    expect(hint).toContain('同一次回复中连续发出多个 dispatch');
    expect(hint).toContain('并行执行');
  });

  it('非 main / 无 subAgents → 空串（standalone 不受影响）', () => {
    expect(formatDispatchHint(makeConfig())).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/dispatch-parallel.test.ts`
Expected: 新增第一条 **failed**（现有教学文案无此句），其余 10 条 passed

- [ ] **Step 3: 修改 `prompt-hints.ts` formatDispatchHint**

「主动拆分原则」列表（现 :38-42）在 `4. 任务简单...` 之后追加第 5 条：

```typescript
5. 子任务相互独立时，在**同一次回复中连续发出多个 dispatch 工具调用**并行执行，不要拆到多轮（多轮 = 串行等待）
```

（列表其余条目与注释不动——「任务可并行」注释在本实现落地后与行为一致，无需改动。）

- [ ] **Step 4: 修改 `pm-agent.yaml:25`**

将：

```yaml
      多个子 agent 可以并行调度。
```

改为：

```yaml
      需要并行调度多个子 agent 时，在同一次回复中连续发出多个 dispatch 工具调用，它们会被并发执行；全部回执到齐后你会一起收到结果。
```

- [ ] **Step 5: 跑测试确认全绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/dispatch-parallel.test.ts`
Expected: **10 passed**

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/agent/prompt-hints.ts electron/resources/agents/pm-agent.yaml electron/tests/agent/dispatch-parallel.test.ts
git commit -m "feat(agent): PM prompt 同轮连发教学——pm-agent.yaml 与 formatDispatchHint 教 LLM 并行派发"
```

---

### Task 4: 全量回归验收（spec §12）

**Files:**
- 无代码改动（纯验证；发现问题回上游 Task 修，不在本 Task 内新改代码）

**Interfaces:**
- Consumes: Task 1-3 的全部产出
- Produces: spec §12 验收证据（测试 + typecheck 层；GUI 层验收留 macOS 主机，与项目惯例一致）

- [ ] **Step 1: electron 全量测试**

Run: `npx pnpm@9.0.0 --filter momo-studio-electron test`
Expected: 全部 passed，零 flake（基线 1074+10 新增）

- [ ] **Step 2: 双 workspace typecheck**

Run: `npx pnpm@9.0.0 typecheck`
Expected: electron + renderer 双 clean（renderer 未改动，作契约零破溃的旁证）

- [ ] **Step 3: 确认契约面零改动**

Run: `git diff --stat dd2ad82..HEAD -- electron/src/main/agent/dispatch.ts electron/src/main/agent/stream-chunk.ts electron/src/preload renderer/`
Expected: 空输出（`dispatch.ts` / `stream-chunk.ts` / preload / renderer 全程未动——spec §8 契约零改动）

- [ ] **Step 4: 无 commit（验证 Task）**

---

## 自审记录（writing-plans Self-Review）

1. **Spec 覆盖**：§4（Task 2 Step 1-4）/ §4.1 chip 即刻出现（Task 1 用例 2）/ §4.2 保序（用例 3）/ §4.3 截断（用例 5、8）/ §5 预算（用例 4、5）/ §6.1 中断（用例 6）/ §6.3 dispatchInfo 独立（Task 2 Step 1 注释 + 实现 `seg.map(() => ({...}))`）/ §7 prompt（Task 3）/ §8 契约（Task 4 Step 3）/ §9 全部 7 类用例（用例 1-8 映射见 Task 1 背景；「段长 1 回归」由既有单 dispatch 套件承担，Task 2 Step 6 显式跑）/ §11 文件清单一致 / §12（Task 4）
2. **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码
3. **类型一致性**：`execDispatchCall(tc: LLMToolCall, subBudget: number, dispatchInfo: { toolCallsUsed: number }): Promise<string>` 在 Step 1 定义与 Step 4 调用一致；测试 harness 函数名在 Task 1 / Task 3 间一致（`makeMainConfig` / `makeConfig`）
