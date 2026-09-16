// electron/tests/agent/runtime-resume.test.ts
//
// v2.6.0 断点续跑 Task 4：runChatLoop resumeTurn 参数（plan Task 4 Interfaces）。
//
// 测试模式：fake LLM 确定流直调 runChatLoop（照 runtime-entry-steer.test.ts 的
// 直调骨架 + runtime-task-driven.test.ts 的 mockProviderOverride 精神）。
//
// 断言清单（plan Task 4 Step 1）：
//   1. 首轮 LLM 请求 messages 含重建段（原 user + 已完成 tool 对 + 孤儿合成
//      result），不含重复 currentBody
//   2. 预算续扣：resumeTurn.toolCallsUsed=2 / maxToolCalls=5 → fake LLM 每轮
//      要 1 工具 → 再 3 次后预算耗尽 end(budget_exhausted)
//   3. 未消费 steer 重放：经既有 drain 路径注入（首轮 LLM 前出现
//      [用户中途补充] + steer 事件 chunk + mandate 段同步恰好一次）
//   4. 无 resumeTurn → messages 形状与现状一致（system + conv + user(currentBody)）
//   5. degenerate 重建段（messages 仅 user）→ 等价正常回合
//
// 边界补充（momo-test-rules 铁律 3——空输入/错误路径专项）：
//   - 重建段为空（T1 degenerate 兜底形态）→ currentBody 作 user 消息兜底
//   - 重建段 assistant 开头（dispatch 子流形态，T1 concern）→ 不注入 user 消息，
//     mandate.userBody 回退 currentBody
//   - 预算钳制：toolCallsUsed ≥ max → 剩余 0，首个工具请求即刻 budget_exhausted
//   - maxToolCalls=-1（无限）+ toolCallsUsed>0 → Infinity 保持，不续扣
//   - convCtx 照拉但排除断点族（C1）：早前会话历史照常进入 conv，被中断族 F
//     由 resumeTurn 独家携带（convCtx 再展开 = 整族双拼 + user 指令时序倒置）
//
// 契约锁（momo-test-rules 铁律 4）：孤儿合成 result 直接 import T1 的
// INTERRUPTED_TOOL_RESULT 常量断言——生产者（rebuildTurn）与消费者（本参数
// 透传进 LLM 上下文）不经手写中间数据。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LLMMessage, StreamDelta } from '../../src/main/agent/llm-provider';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';
import { closeDb } from '../../src/main/storage/db';
import {
  INTERRUPTED_TOOL_RESULT,
  rebuildTurn,
  type RebuiltTurn,
} from '../../src/main/agent/turn-reconstructor';

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
import {
  runChatLoop,
  type RuntimeContext,
} from '../../src/main/agent/runtime-entry';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import { buildToolRegistry } from '../../src/main/agent/tools';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';
import { runMigrations, getDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';
import {
  __routeChunkToBufferForTest,
  __resetEventBufferForTest,
  __flushEventBufferForTest,
} from '../../src/main/agent/stream-relay';

// === 夹具（沿用 runtime-entry-steer.test.ts 模式）===

const sentChunks: unknown[] = [];

// runChatLoop 会话边界过滤每轮触 DB + B 段 rebuildSessionContext 直读 DB——
// 每用例全新临时库：既防惰性 getDb 落默认用户目录缓存句柄，也防 seed 历史
// 跨用例泄漏进 convCtx（B 段前 stub 每用例重置的等价物）；用例后 closeDb
// 防句柄泄漏
let tmpDir = '';
beforeEach(() => {
  tmpDir = path.join(
    os.tmpdir(),
    `ap-resume-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpDir;
  runMigrations();
  __resetEventBufferForTest();
});
afterEach(() => {
  __resetEventBufferForTest();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// B 段后顶层路径 convCtx 走 rebuildSessionContext（真实 DB），stub 不再消费
const stubProvider: MemoryProvider = {
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

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-bot',
    agentUserId: '@bot:localhost',
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
    isLeader: false,
    devMode: false,
    maxToolCalls: 10,
    contextWindow: 0, // 0=未知 → auto 压缩 fail-safe 跳过（同既有测试的缺省行为）
    outputTokens: 0,
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
    creatorUserId: 'user-1',
    toolModules: buildToolRegistry({
      wsFs: mockWsFs,
      workspaceId: 'ws-1',
      workspaceDir: '/tmp/test',
      skillRegistry: mockSkillRegistry,
      streamSessionId: 'test-session',
      roomId: '!room:localhost',
      sendStreamChunk: () => {},
      creatorUserId: 'user-1',
      permissionConfig: { allowedTools: [], deniedTools: [] },
    }),
    ...overrides,
  };
}

/** 单轮收尾的 fake LLM：捕获首轮请求 messages 后 text + stop */
function mockSingleRoundStop(capture: (msgs: LLMMessage[]) => void): void {
  vi.mocked(createLLMProvider).mockReturnValue({
    chat: vi.fn(),
    chatStream: vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
      capture([...messages]);
      yield { type: 'text', content: '已续跑' };
      yield { type: 'done', finishReason: 'stop' };
    }) as never,
  });
}

/** 从 sentChunks 取 system 消息正文（首轮请求的 mandate 段断言用，由捕获数组提供） */
function systemContentOf(messages: LLMMessage[]): string {
  const sys = messages.find((m) => m.role === 'system');
  if (!sys) throw new Error('system 消息未找到');
  return sys.content;
}

function endChunkOf(): { finishReason: string } | undefined {
  return sentChunks.find(
    (c): c is { type: 'end'; finishReason: string } =>
      typeof c === 'object' && c !== null && (c as { type?: string }).type === 'end',
  );
}

describe('runChatLoop resumeTurn（断点续跑参数）', () => {
  const originalSend = process.send;

  beforeEach(() => {
    sentChunks.length = 0;
    vi.mocked(createLLMProvider).mockReset();
    __setMemoryProviderForTest(stubProvider);
    process.send = ((msg: unknown): boolean => {
      sentChunks.push(msg);
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
  });

  it('首轮 LLM 请求 messages 含完整重建段（原 user + 已完成 tool 对 + 孤儿合成 result），不追加重复 currentBody', async () => {
    let first: LLMMessage[] = [];
    mockSingleRoundStop((m) => { first = m; });

    const resumeTurn: RebuiltTurn = {
      messages: [
        { role: 'user', content: '修复登录页崩溃' },
        {
          role: 'assistant',
          content: '我先看下代码',
          toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'login.tsx' } }],
        },
        { role: 'tool', content: '(login.tsx 内容)', toolCallId: 'call-1' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-2', name: 'bash', arguments: { command: 'npm test' } }],
        },
        { role: 'tool', content: INTERRUPTED_TOOL_RESULT, toolCallId: 'call-2' },
      ],
      toolCallsUsed: 2,
      steers: [],
      degenerate: false,
    };
    const stats = { toolCallsUsed: 0 };
    await runChatLoop(
      '!room:t', '修复登录页崩溃', makeConfig(), makeContext(),
      stats, undefined, undefined, 's-resume-1', resumeTurn,
    );

    // 形状：system 占位 + 重建段 5 条 verbatim 拼接（conv 为空）
    expect(first.map((m) => m.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'assistant', 'tool',
    ]);
    // 原 user 消息 verbatim 保留（重建段首条即原 user 消息）
    expect(first[1]).toEqual({ role: 'user', content: '修复登录页崩溃' });
    // 已完成 tool 对保留
    expect(first[2]).toEqual({
      role: 'assistant',
      content: '我先看下代码',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'login.tsx' } }],
    });
    expect(first[3]).toEqual({ role: 'tool', content: '(login.tsx 内容)', toolCallId: 'call-1' });
    // 孤儿 tool_call 合成中断 result（契约：与 T1 常量同源，不手搓文案）
    expect(first[5]).toEqual({ role: 'tool', content: INTERRUPTED_TOOL_RESULT, toolCallId: 'call-2' });
    // 关键断言：不追加重复 currentBody——user 消息仅重建段首条 1 条
    expect(first.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('convCtx 排除断点族（C1）：生产形态 seed + rebuildTurn 真实产物 → 工具对恰一次、user 原指令恰一次且在族内容之前', async () => {
    // 生产形态 seed（resume.ts:320-344 的 DB 后遗形态）：早前完整回合 →
    // owner 原指令行 → 被中断族 F（工具对）——resume 复用断点流派发、不插新
    // owner 行。resumeTurn 用 rebuildTurn(F) 真实产物（非手搓）。
    const T0 = Date.now();
    const ROOM = '!room:t';
    // 早前回合（完整）：owner 问 + agent 文本族
    const earlyUser = insertMessage({ sessionId: ROOM, sender: 'owner', eventType: 'm.room.message', body: '早前问题' });
    getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(T0 + 100, earlyUser.id);
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 's-early', sessionId: ROOM, senderAgentId: 'agent-early',
    });
    __flushEventBufferForTest();
    getDb().prepare('UPDATE messages SET created_at = ? WHERE stream_session_id = ?').run(T0 + 200, 's-early');
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 's-early', delta: '早前回答' });
    __flushEventBufferForTest();
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 's-early', finishReason: 'stop' });
    __flushEventBufferForTest();
    // 族事件统一锚定（含 final）：早前族时间窗 [T0+200, T0+250] 确定性闭合，
    // 防 final 事件真实时刻漂移把 owner 原指令行（T0+300）误吸入 steer 去重窗
    getDb().prepare(
      `UPDATE message_events SET created_at = ? WHERE message_id IN
         (SELECT id FROM messages WHERE stream_session_id = ? OR stream_session_id LIKE ? || '#%')`,
    ).run(T0 + 250, 's-early', 's-early');
    // 断点回合：owner 原指令行 + 被中断族 F（已完成工具对）
    const orig = insertMessage({ sessionId: ROOM, sender: 'owner', eventType: 'm.room.message', body: '修复登录页崩溃' });
    getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(T0 + 300, orig.id);
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 's-bp', sessionId: ROOM, senderAgentId: 'agent-bp',
    });
    __flushEventBufferForTest();
    getDb().prepare('UPDATE messages SET created_at = ? WHERE stream_session_id = ?').run(T0 + 400, 's-bp');
    __routeChunkToBufferForTest({
      type: 'tool_call', streamSessionId: 's-bp', callId: 'cb-1', toolName: 'bash', args: { command: 'npm test' },
    });
    __flushEventBufferForTest();
    __routeChunkToBufferForTest({
      type: 'tool_result', streamSessionId: 's-bp', callId: 'cb-1', toolName: 'bash', result: '全部通过', success: true,
    });
    __flushEventBufferForTest();
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 's-bp', finishReason: 'interrupted' });
    __flushEventBufferForTest();

    // resumeTurn = rebuildTurn(F) 真实产物（生产同款：resume.ts rebuildTurn(breakpointSsId)）
    const resumeTurn: RebuiltTurn = rebuildTurn('s-bp');
    expect(resumeTurn.degenerate).toBe(false); // seed 自检：重建段非空（user + 工具对）

    let first: LLMMessage[] = [];
    mockSingleRoundStop((m) => { first = m; });
    await runChatLoop(
      ROOM, '修复登录页崩溃', makeConfig(), makeContext(),
      { toolCallsUsed: 0 }, undefined, undefined, 's-bp', resumeTurn,
    );

    // 早前回合照拉（排除只针对断点族 F）
    expect(first.some((m) => m.role === 'user' && m.content === '早前问题')).toBe(true);
    expect(first.some((m) => m.role === 'assistant' && m.content === '早前回答')).toBe(true);
    // 断点族工具对（assistant toolCalls + tool result）恰出现一次
    //（旧代码：convCtx 展开族 F + resumeTurn verbatim 再拼接 = 两份）
    const toolMsgs = first.filter((m) => m.role === 'tool' && m.toolCallId === 'cb-1');
    expect(toolMsgs).toHaveLength(1);
    const callAssistants = first.filter(
      (m) => m.role === 'assistant' && (m.toolCalls ?? []).some((tc) => tc.id === 'cb-1'),
    );
    expect(callAssistants).toHaveLength(1);
    // user 原指令恰一次，且时序在族内容之前（旧代码：user 夹在两份族内容中间）
    const origDirective = first.filter((m) => m.role === 'user' && m.content === '修复登录页崩溃');
    expect(origDirective).toHaveLength(1);
    const userIdx = first.indexOf(origDirective[0]!);
    const familyIdx = first.findIndex(
      (m) => m.toolCallId === 'cb-1' || (m.role === 'assistant' && (m.toolCalls ?? []).some((tc) => tc.id === 'cb-1')),
    );
    expect(userIdx).toBeGreaterThan(0); // system 在前
    expect(userIdx).toBeLessThan(familyIdx); // user 在族内容之前（时序不倒置）
  });

  it('预算续扣：toolCallsUsed=2 / maxToolCalls=5 → 再 3 次工具调用后预算耗尽 end(budget_exhausted)', async () => {
    // fake LLM 每轮恰好要 1 个 compact 工具（内联处理不触真实工具模块，照
    // runtime-entry-steer.test.ts 先例）；每轮 args 互异防 v1.5.6 连续重复检测误终止
    let callIndex = 0;
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
        callIndex++;
        yield { type: 'text', content: `第${callIndex}轮` };
        yield {
          type: 'tool_use',
          toolCall: { id: `c-${callIndex}`, name: 'compact', arguments: { note: `n${callIndex}` } },
        };
        yield { type: 'done', finishReason: 'tool_use' };
      }) as never,
    });

    const resumeTurn: RebuiltTurn = {
      messages: [{ role: 'user', content: '续跑指令' }],
      toolCallsUsed: 2,
      steers: [],
      degenerate: false,
    };
    const stats = { toolCallsUsed: 0 };
    await runChatLoop(
      '!room:t', '续跑指令', makeConfig({ maxToolCalls: 5 }), makeContext(),
      stats, undefined, undefined, 's-resume-budget', resumeTurn,
    );

    // 预算 5-2=3：恰好再执行 3 次工具；第 4 轮 LLM 请求发生在预算耗尽判定之前
    const compactResults = sentChunks.filter(
      (c): c is { type: 'tool_result'; toolName: string } =>
        typeof c === 'object' &&
        c !== null &&
        (c as { type?: string }).type === 'tool_result' &&
        (c as { toolName?: string }).toolName === 'compact',
    );
    expect(compactResults).toHaveLength(3);
    expect(callIndex).toBe(4);
    // 本轮计数从 0 起（stats 只报本 run 消耗，断点前 2 次不重复计）
    expect(stats.toolCallsUsed).toBe(3);
    expect(endChunkOf()?.finishReason).toBe('budget_exhausted');
  });

  it('预算钳制：toolCallsUsed ≥ maxToolCalls → 剩余预算 0，首个工具请求即刻 budget_exhausted（零执行）', async () => {
    let callIndex = 0;
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
        callIndex++;
        yield {
          type: 'tool_use',
          toolCall: { id: `c-${callIndex}`, name: 'compact', arguments: { note: `n${callIndex}` } },
        };
        yield { type: 'done', finishReason: 'tool_use' };
      }) as never,
    });

    const resumeTurn: RebuiltTurn = {
      messages: [{ role: 'user', content: '预算已耗尽的续跑' }],
      toolCallsUsed: 5,
      steers: [],
      degenerate: false,
    };
    await runChatLoop(
      '!room:t', '预算已耗尽的续跑', makeConfig({ maxToolCalls: 5 }), makeContext(),
      { toolCallsUsed: 0 }, undefined, undefined, 's-resume-clamp', resumeTurn,
    );

    // 剩余预算 Math.max(0, 5-5)=0：第 1 轮 LLM 返回工具即被预算检查拦截
    expect(callIndex).toBe(1);
    const compactResults = sentChunks.filter(
      (c) =>
        typeof c === 'object' &&
        c !== null &&
        (c as { type?: string }).type === 'tool_result',
    );
    expect(compactResults).toHaveLength(0);
    expect(endChunkOf()?.finishReason).toBe('budget_exhausted');
  });

  it('maxToolCalls=-1（无限）+ toolCallsUsed>0 → Infinity 保持，不续扣', async () => {
    let callIndex = 0;
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
        callIndex++;
        if (callIndex === 1) {
          yield {
            type: 'tool_use',
            toolCall: { id: 'c-1', name: 'compact', arguments: { note: 'n1' } },
          };
          yield { type: 'done', finishReason: 'tool_use' };
          return;
        }
        yield { type: 'text', content: '无限预算下继续' };
        yield { type: 'done', finishReason: 'stop' };
      }) as never,
    });

    const resumeTurn: RebuiltTurn = {
      messages: [{ role: 'user', content: '无限预算续跑' }],
      toolCallsUsed: 7,
      steers: [],
      degenerate: false,
    };
    await runChatLoop(
      '!room:t', '无限预算续跑', makeConfig({ maxToolCalls: -1 }), makeContext(),
      { toolCallsUsed: 0 }, undefined, undefined, 's-resume-inf', resumeTurn,
    );

    // -1 语义保持：断点前消耗不影响无限预算，工具正常执行、自然收尾
    expect(callIndex).toBe(2);
    expect(endChunkOf()?.finishReason).toBe('stop');
  });

  it('未消费 steer 重放：经既有 drain 路径注入——首轮 LLM 前出现 [用户中途补充] + steer 事件 chunk + mandate 段恰好一次', async () => {
    let first: LLMMessage[] = [];
    mockSingleRoundStop((m) => { first = m; });

    const resumeTurn: RebuiltTurn = {
      messages: [{ role: 'user', content: '原始指令' }],
      toolCallsUsed: 0,
      steers: [{ body: '优先跑测试' }],
      degenerate: false,
    };
    await runChatLoop(
      '!room:t', '原始指令', makeConfig(), makeContext(),
      { toolCallsUsed: 0 }, undefined, undefined, 's-resume-steer', resumeTurn,
    );

    // drain 在首轮 LLM 请求之前发生：[用户中途补充] user 消息已进 messages
    const supplement = first.find(
      (m) => m.role === 'user' && m.content === '[用户中途补充] 优先跑测试',
    );
    expect(supplement).toBeDefined();
    // drain 发 steer 事件 chunk（T2 落库链的生产者侧，body 不带前缀）
    const steerChunks = sentChunks.filter(
      (c): c is { type: 'steer'; streamSessionId: string; body: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'steer',
    );
    expect(steerChunks).toHaveLength(1);
    expect(steerChunks[0]).toMatchObject({ streamSessionId: 's-resume-steer', body: '优先跑测试' });
    // mandate 段同步恰好一次（drain 循环 push；若 resume 分支预写 mandate.steers
    // 会双份渲染——本断言同时是防双份回归锁）
    const sys = systemContentOf(first);
    expect(sys).toContain('中途补充：「优先跑测试」');
    expect(sys.match(/优先跑测试/g)).toHaveLength(1);
    expect(sys).toContain('「原始指令」');
  });

  it('未消费 steer 重放（带 context）：注入消息含展开、steer chunk emit 原文+context（Task 6 审查修复）', async () => {
    let first: LLMMessage[] = [];
    mockSingleRoundStop((m) => { first = m; });

    const steerCtx = { skills: [{ slug: 's', name: 'n', body: '技能指令' }], files: [] };
    const resumeTurn: RebuiltTurn = {
      messages: [{ role: 'user', content: '原始指令' }],
      toolCallsUsed: 0,
      steers: [{ body: '优先跑测试', context: steerCtx }],
      degenerate: false,
    };
    await runChatLoop(
      '!room:t', '原始指令', makeConfig(), makeContext(),
      { toolCallsUsed: 0 }, undefined, undefined, 's-resume-steer-ctx', resumeTurn,
    );

    // 注入消息 = 消费点 renderTurnBody 重放的包装体（LLM 视角与到达时一致）
    const supplement = first.find(
      (m) => m.role === 'user' && m.content.includes('[用户中途补充]'),
    );
    expect(supplement).toBeDefined();
    expect(supplement!.content).toContain('<user-context>');
    expect(supplement!.content).toContain('技能指令');
    expect(supplement!.content.endsWith('优先跑测试')).toBe(true);
    // 线协议：steer chunk emit 原文 + context 元数据（不是包装体）
    const steerChunks = sentChunks.filter(
      (c): c is { type: 'steer'; streamSessionId: string; body: string; context?: unknown } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'steer',
    );
    expect(steerChunks).toHaveLength(1);
    expect(steerChunks[0]!.body).toBe('优先跑测试');
    expect(steerChunks[0]!.body).not.toContain('<user-context>');
    expect(steerChunks[0]!.context).toEqual(steerCtx);
  });

  it('无 resumeTurn → 首轮 messages 形状与现状一致（system + user(currentBody)，无额外消息）', async () => {
    let first: LLMMessage[] = [];
    mockSingleRoundStop((m) => { first = m; });

    await runChatLoop(
      '!room:t', '普通消息', makeConfig(), makeContext(),
      { toolCallsUsed: 0 }, undefined, undefined, 's-norm',
    );

    // 对照断言（现状形状）：conv 为空时恰 2 条——system + user(currentBody)
    expect(first).toHaveLength(2);
    expect(first[0]!.role).toBe('system');
    expect(first[0]!.content).not.toBe(''); // refreshSystem 已填充
    expect(first[1]).toEqual({ role: 'user', content: '普通消息' });
  });

  it('degenerate 重建段（messages 仅 user）→ 等价正常回合（用重建段 user，不追加 currentBody）', async () => {
    let first: LLMMessage[] = [];
    mockSingleRoundStop((m) => { first = m; });

    const resumeTurn: RebuiltTurn = {
      messages: [{ role: 'user', content: '断点前的原始指令' }],
      toolCallsUsed: 0,
      steers: [],
      degenerate: true,
    };
    // currentBody 故意不同于重建段 user——证明 messages 取重建段而非 currentBody
    await runChatLoop(
      '!room:t', '恢复兜底正文', makeConfig(), makeContext(),
      { toolCallsUsed: 0 }, undefined, undefined, 's-resume-deg', resumeTurn,
    );

    // 等价正常回合：恰 1 条 user 消息 = 重建段首条（T5 传 body=首条 user 文本，
    // 但实现上 messages 以重建段为准——currentBody 不进 messages）
    expect(first).toHaveLength(2);
    expect(first[1]).toEqual({ role: 'user', content: '断点前的原始指令' });
    expect(first.filter((m) => m.role === 'user')).toHaveLength(1);
    // mandate.userBody = 重建段首条 user（role 判定命中）
    const sys = systemContentOf(first);
    expect(sys).toContain('「断点前的原始指令」');
    expect(sys).not.toContain('「恢复兜底正文」');
  });

  it('重建段为空（T1 degenerate 兜底形态）→ currentBody 作为 user 消息兜底（等价全新回合）', async () => {
    let first: LLMMessage[] = [];
    mockSingleRoundStop((m) => { first = m; });

    const resumeTurn: RebuiltTurn = {
      messages: [],
      toolCallsUsed: 0,
      steers: [],
      degenerate: true,
    };
    await runChatLoop(
      '!room:t', '任务正文兜底', makeConfig(), makeContext(),
      { toolCallsUsed: 0 }, undefined, undefined, 's-resume-empty', resumeTurn,
    );

    // 空重建段无 user 消息可拼——currentBody 兜底为唯一 user 消息（fresh 回合形状）
    expect(first).toHaveLength(2);
    expect(first[1]).toEqual({ role: 'user', content: '任务正文兜底' });
    expect(first.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(systemContentOf(first)).toContain('「任务正文兜底」');
  });

  it('重建段 assistant 开头（dispatch 子流形态）→ 不注入 user 消息，mandate.userBody 回退 currentBody', async () => {
    let first: LLMMessage[] = [];
    mockSingleRoundStop((m) => { first = m; });

    const resumeTurn: RebuiltTurn = {
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-9', name: 'grep', arguments: { pattern: 'TODO' } }],
        },
        { role: 'tool', content: INTERRUPTED_TOOL_RESULT, toolCallId: 'call-9' },
      ],
      toolCallsUsed: 1,
      steers: [],
      degenerate: false,
    };
    await runChatLoop(
      '!room:t', '子任务指令兜底', makeConfig(), makeContext(),
      { toolCallsUsed: 0 }, undefined, undefined, 's-resume-sub', resumeTurn,
    );

    // dispatch 子流重建段可能 assistant 开头（T1 concern）：messages 无 user 消息，
    // 原样拼接；指令经 mandate.userBody（system 授权段）兜底呈现
    expect(first.map((m) => m.role)).toEqual(['system', 'assistant', 'tool']);
    expect(first[2]).toEqual({ role: 'tool', content: INTERRUPTED_TOOL_RESULT, toolCallId: 'call-9' });
    const sys = systemContentOf(first);
    expect(sys).toContain('「子任务指令兜底」');
  });
});
