// electron/tests/agent/runtime-turn-context.test.ts
//
// v2.11 输入框上下文（Task 6 接线锁）：task-config.context / steer.context 经
// renderTurnBody 包装进本轮用户正文。锁三层消费行为：
//   1. runTaskChatLoop：cfg.context 解构 → runChatLoop 第 2 参 body 前置
//      <user-context> 块（摘掉解构/包装必红——context 静默丢失不报错）
//   2. steer 监听器：steer 消息 context 在推入 pendingSteers 前同样包装
//      （runChatLoop 直测两轮结构，照抄 runtime-entry-steer.test.ts 模式）
//   3. isExpandedContext guard：steer 载荷 unknown 形状收窄（合法 / 缺字段 /
//      非对象），缺字段按 undefined 回退不包装
// 回归锁：无 context 时 body 原样（线协议零变化，老载荷兼容）。
//
// 注：runChatLoop 与 runTaskChatLoop 同文件定义，无法 vi.mock 单独替换——
// body 经首条 user 消息落地观测（L634 无 resume/historyPrefix 时 verbatim），
// 与 runtime-task-driven.test.ts「v2.6.0 resume 接线锁」同一观测模式。

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LLMMessage, StreamDelta } from '../../src/main/agent/llm-provider';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';

// 必须在 import runtime-entry 之前 mock llm-provider（vi.mock 会被 hoist）
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import { runTaskChatLoop, runChatLoop, type RuntimeContext } from '../../src/main/agent/runtime-entry';
import { isExpandedContext } from '../../src/main/agent/turn-context';
import type { RuntimeConfig, TaskConfig } from '../../src/main/agent/runtime-config';
import { buildToolRegistry } from '../../src/main/agent/tools';
import { closeDb } from '../../src/main/storage/db';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

// === Mock 状态 / 夹具（原样搬自 runtime-task-driven.test.ts） ===

// runChatLoop 会话边界过滤每轮触 DB——文件级兜底：未显式设 AP_USER_DATA_DIR 的
// describe 也指向临时目录（防惰性 getDb 落到默认用户目录缓存句柄）；每用例后
// closeDb 防句柄泄漏
const fallbackTmp = path.join(
  os.tmpdir(),
  `ap-rtctx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
beforeEach(() => {
  if (!process.env.AP_USER_DATA_DIR) {
    fs.mkdirSync(fallbackTmp, { recursive: true });
    process.env.AP_USER_DATA_DIR = fallbackTmp;
  }
});
afterEach(() => {
  closeDb();
});
afterAll(() => {
  fs.rmSync(fallbackTmp, { recursive: true, force: true });
});

// MemoryProvider stub：默认空上下文（getTaskContext=null / 会话无历史）
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
    roomId: '!room:localhost',
    streamSessionId: 'test-session',
    sendStreamChunk: () => {},
    toolModules: buildToolRegistry({
      wsFs: mockWsFs,
      workspaceId: 'ws-1',
      workspaceDir: '/tmp/test',
      creatorUserId: '@owner:test',
      skillRegistry: mockSkillRegistry,
      streamSessionId: 'test-session',
      roomId: '!room:localhost',
      sendStreamChunk: () => {},
      permissionConfig: { allowedTools: [], deniedTools: [] },
    }),
    ...overrides,
  };
}

function makeTaskConfig(overrides: Partial<TaskConfig> = {}): TaskConfig {
  return {
    type: 'task-config',
    taskId: null,
    executionSessionId: '!room:localhost',
    body: 'hi',
    streamSessionId: 'task-session-001',
    ...overrides,
  };
}

/** 捕获首轮 LLM messages 的 chatStream mock（原地写入——调用方持有的数组引用在 generator 执行后可见） */
function captureFirstMessages(): LLMMessage[] {
  const first: LLMMessage[] = [];
  vi.mocked(createLLMProvider).mockReturnValue({
    chat: vi.fn(),
    chatStream: vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
      first.push(...messages);
      yield { type: 'text', content: 'done' };
      yield { type: 'done', finishReason: 'stop' };
    }),
  });
  return first;
}

// @types/node 对 emit('message') 有专用重载形态（message + sendHandle），测试以
// 单参消息体模拟子进程 IPC——经通用签名强转发出（运行时与 process.emit 等价）
const emitChildMessage = (msg: unknown): void => {
  (process.emit as (event: string, ...args: unknown[]) => boolean)('message', msg);
};

// === runTaskChatLoop：task-config.context 包装 ===

describe('runTaskChatLoop context 包装（task-config → runChatLoop body）', () => {
  const originalSend = process.send;

  beforeEach(() => {
    vi.mocked(createLLMProvider).mockReset();
    __setMemoryProviderForTest(stubMemoryProvider);
    // sendTaskEndAndExit 依赖 process.send 回调 flush——mock 捕获即可（不路由）
    process.send = ((msg: unknown, callback?: (err: Error | null) => void): boolean => {
      if (callback) callback(null);
      return true;
    }) as NonNullable<typeof process.send>;
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
    vi.restoreAllMocks();
  });

  it('context 存在时 body 前置 <user-context> 块（接线锁：摘掉解构/包装必红）', async () => {
    const first = captureFirstMessages();

    await runTaskChatLoop(
      makeTaskConfig({
        body: '正文',
        streamSessionId: 's-ctx-1',
        context: { skills: [{ slug: 's', name: 'n', body: '技能指令' }], files: [] },
      }),
      makeConfig(),
      makeContext(),
    );

    // 无 resume/historyPrefix 时 runChatLoop 第 2 参 verbatim 落为首条 user 消息
    const userMsgs = first.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    const body = userMsgs[0]!.content;
    expect(body).toContain('<user-context>');
    expect(body).toContain('技能指令');
    expect(body.endsWith('正文')).toBe(true);
  });

  it('context 含文件时文件内容同样进块', async () => {
    const first = captureFirstMessages();

    await runTaskChatLoop(
      makeTaskConfig({
        body: '看下这个文件',
        streamSessionId: 's-ctx-2',
        context: {
          skills: [],
          files: [{ path: 'src/a.ts', content: 'const a = 1;' }],
        },
      }),
      makeConfig(),
      makeContext(),
    );

    const body = first.filter((m) => m.role === 'user')[0]!.content;
    expect(body).toContain('<file path="src/a.ts">');
    expect(body).toContain('const a = 1;');
    expect(body.endsWith('看下这个文件')).toBe(true);
  });

  it('无 context 时 body 原样（回归锁：线协议零变化）', async () => {
    const first = captureFirstMessages();

    await runTaskChatLoop(
      makeTaskConfig({ body: '正文', streamSessionId: 's-ctx-3' }),
      makeConfig(),
      makeContext(),
    );

    const userMsgs = first.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]!.content).toBe('正文');
  });

  it('空 skills/files 的 context → 渲染块为空，body 原样（不注入空 <user-context>）', async () => {
    const first = captureFirstMessages();

    await runTaskChatLoop(
      makeTaskConfig({
        body: '正文',
        streamSessionId: 's-ctx-4',
        context: { skills: [], files: [] },
      }),
      makeConfig(),
      makeContext(),
    );

    expect(first.filter((m) => m.role === 'user')[0]!.content).toBe('正文');
  });
});

// === steer 监听器：steer 消息 context 包装（runChatLoop 直测） ===

describe('steer 监听器 context 包装（steer → pendingSteers）', () => {
  beforeEach(() => {
    vi.mocked(createLLMProvider).mockReset();
    __setMemoryProviderForTest(stubMemoryProvider);
  });

  afterEach(() => {
    __resetMemoryProviderForTest();
    vi.restoreAllMocks();
  });

  it('steer 消息带合法 context → 下一轮 [用户中途补充] 含 <user-context> 块', async () => {
    // 两轮结构（照抄 runtime-entry-steer.test.ts）：round1 text + compact + emit steer；
    // round2 捕获 messages 断言 drain 注入的补充已包装
    let callIndex = 0;
    let round2Messages: LLMMessage[] = [];
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
        callIndex++;
        if (callIndex === 1) {
          yield { type: 'text', content: '先总结' };
          yield {
            type: 'tool_use',
            toolCall: { id: 'c1', name: 'compact', arguments: { summary: 'S'.repeat(60) } },
          };
          yield { type: 'done', finishReason: 'tool_use' };
          // compact 内联处理在 generator 结束后、下一轮 drain 前执行——此刻注入 steer
          emitChildMessage({
            type: 'steer',
            streamSessionId: 's-ctx-steer',
            body: '补充说明 X',
            context: { skills: [{ slug: 's', name: 'n', body: '技能指令' }], files: [] },
          });
          return;
        }
        round2Messages = [...messages];
        yield { type: 'text', content: '收到补充' };
        yield { type: 'done', finishReason: 'stop' };
      }) as never,
    });

    const stats = { toolCallsUsed: 0 } as { toolCallsUsed: number; aborted?: boolean };
    await runChatLoop('!room:t', '初始问题', makeConfig(), makeContext(), stats, undefined, undefined, 's-ctx-steer');

    const supplement = round2Messages.find(
      (m) => m.role === 'user' && m.content.includes('[用户中途补充]'),
    );
    expect(supplement).toBeDefined();
    expect(supplement!.content).toContain('<user-context>');
    expect(supplement!.content).toContain('技能指令');
    // 块在前正文在后：包装体以原 steer body 收尾
    expect(supplement!.content.endsWith('补充说明 X')).toBe(true);
  });

  it('steer 消息无 context → 补充原样（回归锁，与 runtime-entry-steer.test.ts 同型）', async () => {
    let callIndex = 0;
    let round2Messages: LLMMessage[] = [];
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
        callIndex++;
        if (callIndex === 1) {
          yield { type: 'text', content: '先总结' };
          yield {
            type: 'tool_use',
            toolCall: { id: 'c1', name: 'compact', arguments: { summary: 'S'.repeat(60) } },
          };
          yield { type: 'done', finishReason: 'tool_use' };
          emitChildMessage({ type: 'steer', streamSessionId: 's-ctx-steer', body: '补充说明 X' });
          return;
        }
        round2Messages = [...messages];
        yield { type: 'text', content: '收到补充' };
        yield { type: 'done', finishReason: 'stop' };
      }) as never,
    });

    const stats = { toolCallsUsed: 0 } as { toolCallsUsed: number; aborted?: boolean };
    await runChatLoop('!room:t', '初始问题', makeConfig(), makeContext(), stats, undefined, undefined, 's-ctx-steer');

    const supplements = round2Messages.filter(
      (m) => m.role === 'user' && m.content.startsWith('[用户中途补充]'),
    );
    expect(supplements).toHaveLength(1);
    expect(supplements[0]!.content).toBe('[用户中途补充] 补充说明 X');
  });

  it('steer 消息 context 形状不合法（缺 files）→ guard 收窄为 undefined，补充原样', async () => {
    let callIndex = 0;
    let round2Messages: LLMMessage[] = [];
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
        callIndex++;
        if (callIndex === 1) {
          yield { type: 'text', content: '先总结' };
          yield {
            type: 'tool_use',
            toolCall: { id: 'c1', name: 'compact', arguments: { summary: 'S'.repeat(60) } },
          };
          yield { type: 'done', finishReason: 'tool_use' };
          // 恶意/漂移载荷：context 缺 files 字段——isExpandedContext 应判否
          emitChildMessage({
            type: 'steer',
            streamSessionId: 's-ctx-steer',
            body: '补充说明 X',
            context: { skills: [{ slug: 's', name: 'n', body: '不应注入' }] },
          });
          return;
        }
        round2Messages = [...messages];
        yield { type: 'text', content: '收到补充' };
        yield { type: 'done', finishReason: 'stop' };
      }) as never,
    });

    const stats = { toolCallsUsed: 0 } as { toolCallsUsed: number; aborted?: boolean };
    await runChatLoop('!room:t', '初始问题', makeConfig(), makeContext(), stats, undefined, undefined, 's-ctx-steer');

    const supplements = round2Messages.filter(
      (m) => m.role === 'user' && m.content.startsWith('[用户中途补充]'),
    );
    expect(supplements).toHaveLength(1);
    // 关键断言：非法形状不包装、不注入任何 skill 正文
    expect(supplements[0]!.content).toBe('[用户中途补充] 补充说明 X');
    expect(round2Messages.some((m) => m.content.includes('不应注入'))).toBe(false);
  });
});

// === steer 线协议（Task 6 审查修复回归锁）：chunk emit 原文 + context，非包装体 ===
// 缺陷复现锁：修复前 push 点即包装——drain emit 的 steer chunk body 是
// <user-context> 包装体且无 context 字段 → stream-relay 落库 → turn-reconstructor
// 在每一后续回合的会话重建里重复注入 skill/文件展开（spec D2「一次性注入」破坏）。

describe('steer drain 线协议（chunk emit 原文+context）', () => {
  const originalSend = process.send;
  const wireChunks: unknown[] = [];

  beforeEach(() => {
    wireChunks.length = 0;
    vi.mocked(createLLMProvider).mockReset();
    __setMemoryProviderForTest(stubMemoryProvider);
    process.send = ((msg: unknown): boolean => {
      wireChunks.push(msg);
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
    vi.restoreAllMocks();
  });

  it('带 context 的 steer → chunk body=原文、context=元数据；LLM 注入消息仍见包装体', async () => {
    const steerCtx = { skills: [{ slug: 's', name: 'n', body: '技能指令' }], files: [] };
    let callIndex = 0;
    let round2Messages: LLMMessage[] = [];
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
        callIndex++;
        if (callIndex === 1) {
          yield { type: 'text', content: '先总结' };
          yield {
            type: 'tool_use',
            toolCall: { id: 'c1', name: 'compact', arguments: { summary: 'S'.repeat(60) } },
          };
          yield { type: 'done', finishReason: 'tool_use' };
          emitChildMessage({
            type: 'steer',
            streamSessionId: 's-ctx-wire',
            body: '补充说明 X',
            context: steerCtx,
          });
          return;
        }
        round2Messages = [...messages];
        yield { type: 'text', content: '收到补充' };
        yield { type: 'done', finishReason: 'stop' };
      }) as never,
    });

    const stats = { toolCallsUsed: 0 } as { toolCallsUsed: number; aborted?: boolean };
    await runChatLoop('!room:t', '初始问题', makeConfig(), makeContext(), stats, undefined, undefined, 's-ctx-wire');

    // ① 线协议：steer chunk body=原文（不含包装），context 携带元数据
    const steerChunks = wireChunks.filter(
      (c): c is { type: 'steer'; streamSessionId: string; body: string; context?: unknown } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'steer',
    );
    expect(steerChunks).toHaveLength(1);
    expect(steerChunks[0]!.body).toBe('补充说明 X');
    expect(steerChunks[0]!.body).not.toContain('<user-context>');
    expect(steerChunks[0]!.context).toEqual(steerCtx);

    // ② LLM 视角不变：注入消息 = 包装体（块在前正文在后）
    const supplement = round2Messages.find(
      (m) => m.role === 'user' && m.content.includes('[用户中途补充]'),
    );
    expect(supplement).toBeDefined();
    expect(supplement!.content).toContain('<user-context>');
    expect(supplement!.content.endsWith('补充说明 X')).toBe(true);
  });

  it('无 context 的 steer → chunk body=原文且无 context 字段（线协议零变化回归锁）', async () => {
    let callIndex = 0;
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
        callIndex++;
        if (callIndex === 1) {
          yield { type: 'text', content: '先总结' };
          yield {
            type: 'tool_use',
            toolCall: { id: 'c1', name: 'compact', arguments: { summary: 'S'.repeat(60) } },
          };
          yield { type: 'done', finishReason: 'tool_use' };
          emitChildMessage({ type: 'steer', streamSessionId: 's-ctx-wire', body: '补充说明 X' });
          return;
        }
        yield { type: 'text', content: '收到补充' };
        yield { type: 'done', finishReason: 'stop' };
      }) as never,
    });

    const stats = { toolCallsUsed: 0 } as { toolCallsUsed: number; aborted?: boolean };
    await runChatLoop('!room:t', '初始问题', makeConfig(), makeContext(), stats, undefined, undefined, 's-ctx-wire');

    const steerChunks = wireChunks.filter(
      (c): c is { type: 'steer'; streamSessionId: string; body: string; context?: unknown } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'steer',
    );
    expect(steerChunks).toHaveLength(1);
    expect(steerChunks[0]!.body).toBe('补充说明 X');
    expect('context' in steerChunks[0]!).toBe(false);
  });
});

// === isExpandedContext guard（steer 载荷 unknown → ExpandedContext | undefined） ===

describe('isExpandedContext（形状收窄）', () => {
  it('合法 ExpandedContext 通过', () => {
    expect(isExpandedContext({ skills: [], files: [] })).toBe(true);
    expect(
      isExpandedContext({
        skills: [{ slug: 's', name: 'n', body: 'b' }],
        files: [{ path: 'p', content: null }],
      }),
    ).toBe(true);
  });

  it('缺 skills / files 字段不通过', () => {
    expect(isExpandedContext({ skills: [] })).toBe(false);
    expect(isExpandedContext({ files: [] })).toBe(false);
    expect(isExpandedContext({})).toBe(false);
  });

  it('非对象（null / undefined / 数组 / 字符串 / 数字）不通过', () => {
    expect(isExpandedContext(null)).toBe(false);
    expect(isExpandedContext(undefined)).toBe(false);
    // 数组 typeof 'object' 但无 skills/files 字段——必须判否
    expect(isExpandedContext([])).toBe(false);
    expect(isExpandedContext('skills')).toBe(false);
    expect(isExpandedContext(42)).toBe(false);
  });
});
