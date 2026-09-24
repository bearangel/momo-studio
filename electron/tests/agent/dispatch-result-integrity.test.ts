// electron/tests/agent/dispatch-result-integrity.test.ts
//
// P0 结果完整性（spec 2026-09-24 §6）回归锁：
//   1. 分段重组（P0-1）：task_complete 分段后的终态 finalText 必须含全部段
//      全文 + 末段尾巴——旧实现只回传末段（会话 e7f8ec7e 实测：14 项报告
//      回执只剩 1 行收尾摘要，前段全部丢失）
//   2. 分段上限溢出（P0-1 边界）：第 6 次 task_complete 触发强制结束时，
//      未持久化的 summary 并入终态（不丢）
//   3. 超长落盘引用（P0-2）：dispatch 终态回执超 8KB → 全文写
//      .momo-scratch/dispatch/<chainId>.md，task_reply.body 换「落盘说明 +
//      头部摘录 + 相对路径」；阈值内原样回传；写盘失败降级回原文
//
// fixture（momo-test-rules 保真度）：mock 仅 LLM 边界（createLLMProvider 多轮
// 预置）+ process.send 进程边界；runChatLoop / runTaskChatLoop / 分段 /
// 落盘全部真实实现；真实临时目录承载落盘断言。
import { describe, it, expect, vi, beforeEach, afterEach, afterAll, type MockInstance } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { StreamDelta } from '../../src/main/agent/llm-provider';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';

vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import {
  runChatLoop,
  runTaskChatLoop,
  spillDispatchBodyIfNeeded,
  DISPATCH_BODY_SPILL_THRESHOLD_BYTES,
  type RuntimeContext,
} from '../../src/main/agent/runtime-entry';
import type { RuntimeConfig, TaskConfig } from '../../src/main/agent/runtime-config';
import { buildToolRegistry } from '../../src/main/agent/tools';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';
import { closeDb } from '../../src/main/storage/db';

// === 夹具（runtime-task-driven / runtime-segment 同款形态） ===

const sentChunks: unknown[] = [];
const sentIpc: unknown[] = [];
const originalSend = process.send;

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-dispatch-integrity-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

// runChatLoop 会话边界过滤每轮触 DB——指向临时目录防句柄污染（同款文件级兜底）
beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
});
afterEach(() => {
  closeDb();
});
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

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
    agentAssignmentId: 'inst-sub',
    agentUserId: 'agent-inst-sub',
    systemPrompt: 'You are a test bot.',
    modelName: 'test-model',
    llmApiKey: 'test-key',
    workspaceDir: tmpRoot,
    workspaceId: 'ws-1',
    role: 'sub',
    contextWindow: 0,
    outputTokens: 0,
    subAgents: [],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: false,
    devMode: false,
    maxToolCalls: -1,
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
    tools: [
      {
        name: 'task_complete',
        description: '分段',
        inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
      },
    ],
    systemPrompt: 'You are a helpful assistant.',
    workspaceId: 'ws-1',
    workspaceDir: tmpRoot,
    creatorUserId: '@owner:test',
    roomId: '!room:localhost',
    streamSessionId: 'test-session',
    sendStreamChunk: () => {},
    toolModules: buildToolRegistry({
      wsFs: mockWsFs,
      workspaceId: 'ws-1',
      workspaceDir: tmpRoot,
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

/** task_complete 的 tool_use delta 快捷构造 */
function seg(roundId: string, summary: string): StreamDelta[] {
  return [
    { type: 'tool_use', toolCall: { id: roundId, name: 'task_complete', arguments: { summary } } },
    { type: 'done', finishReason: 'tool_use' },
  ];
}

// ══════════════════════════════════════════════════════════════════════════
// P0-1：分段重组
// ══════════════════════════════════════════════════════════════════════════

describe('P0-1 分段重组：终态 finalText 含全部段全文', () => {
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

  it('两次 task_complete + 末段文本 → 返回值 = 段一 + 段二 + 收尾（双换行连接）', async () => {
    mockProviderMultiRound([
      seg('c1', '## 一、严重问题\nS1 弱凭据…'),
      seg('c2', '## 二、中等问题\nM1 密码策略…'),
      [{ type: 'text', content: '报告完毕（严重 2 / 中等 1）。' }, { type: 'done', finishReason: 'stop' }],
    ]);

    const out = await runChatLoop('!room:localhost', '长任务分析', makeConfig(), makeContext());

    // 核心回归锁：三部分全在（旧实现只剩「报告完毕…」收尾句）
    expect(out).toContain('## 一、严重问题');
    expect(out).toContain('S1 弱凭据');
    expect(out).toContain('## 二、中等问题');
    expect(out).toContain('M1 密码策略');
    expect(out).toContain('报告完毕（严重 2 / 中等 1）');
    // 顺序：段一 → 段二 → 收尾
    expect(out.indexOf('## 一、严重问题')).toBeLessThan(out.indexOf('## 二、中等问题'));
    expect(out.indexOf('## 二、中等问题')).toBeLessThan(out.indexOf('报告完毕'));
  });

  it('无 summary 的 task_complete（同轮文本已消费进 messages）→ 段占位 (空段)，末段仍回传', async () => {
    // 实测语义：task_complete 所在轮的 text 在进入工具循环前已被 push 进
    // messages 并重置 accumulatedText——段内容只经 summary 参数承载（会话
    // e7f8ec7e 中子 agent 的实际行为即如此）。此处锁定该语义不回归。
    mockProviderMultiRound([
      [
        { type: 'text', content: '同轮说明文字' },
        { type: 'tool_use', toolCall: { id: 'c1', name: 'task_complete', arguments: {} } },
        { type: 'done', finishReason: 'tool_use' },
      ],
      [{ type: 'text', content: '末段内容' }, { type: 'done', finishReason: 'stop' }],
    ]);

    const out = await runChatLoop('!room:localhost', '长任务', makeConfig(), makeContext());
    expect(out).toContain('(空段)');
    expect(out).toContain('末段内容');
  });

  it('分段上限溢出（第 6 次 task_complete）→ 未持久化的 summary 并入终态不丢失', async () => {
    mockProviderMultiRound([
      seg('c1', '段一'),
      seg('c2', '段二'),
      seg('c3', '段三'),
      seg('c4', '段四'),
      seg('c5', '段五'),
      seg('c6', '段六溢出'),
    ]);

    const out = await runChatLoop('!room:localhost', '超长任务', makeConfig(), makeContext());
    // 前 5 段 + 溢出 summary 全部保留
    for (const s of ['段一', '段二', '段三', '段四', '段五', '段六溢出']) {
      expect(out).toContain(s);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P0-2：超长回执落盘引用
// ══════════════════════════════════════════════════════════════════════════

describe('P0-2 超长回执落盘 + 摘要引用', () => {
  let exitSpy: MockInstance<Parameters<typeof process.exit>, ReturnType<typeof process.exit>>;

  beforeEach(() => {
    sentChunks.length = 0;
    sentIpc.length = 0;
    vi.mocked(createLLMProvider).mockReset();
    __setMemoryProviderForTest(stubProvider);
    process.send = ((msg: unknown, callback?: (err: Error | null) => void): boolean => {
      const m = msg as { type?: string };
      if (m.type && ['start', 'thinking', 'text', 'tool_call', 'tool_result', 'end'].includes(m.type)) {
        sentChunks.push(msg);
      } else {
        sentIpc.push(msg);
      }
      if (callback) callback(null);
      return true;
    }) as NonNullable<typeof process.send>;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });
  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
    exitSpy.mockRestore();
  });

  function makeDispatchTaskConfig(chainId: string): TaskConfig {
    return {
      type: 'task-config',
      taskId: null,
      executionSessionId: '!room:localhost',
      body: '长任务',
      streamSessionId: `sub-sess-${chainId}`,
      dispatchContext: { fromAssignmentId: 'inst-pm', task_id: chainId },
    };
  }

  /** 从 sentIpc 取终态（completed）task_reply content */
  function terminalReply(): { body: string; task_id: string } | undefined {
    const evt = sentIpc.find(
      (m) =>
        (m as { type?: string }).type === 'momo-internal-event' &&
        (m as { eventType?: string }).eventType === 'io.momo-studio.task_reply' &&
        (m as { content?: { status?: string } }).content?.status === 'completed',
    ) as { content: { body: string; task_id: string } } | undefined;
    return evt?.content;
  }

  it('回执超阈值 → 全文落盘 + body 换引用（含头部摘录与相对路径），文件可读回原文', async () => {
    const CHAIN = 'T-spill-1';
    // 构造 >8KB 正文：头部标记 + 大块正文 + 尾部标记（尾部标记不应出现在回执 body）
    const head = '# 完整分析报告\n';
    const filler = 'x'.repeat(DISPATCH_BODY_SPILL_THRESHOLD_BYTES + 1024);
    const fullText = `${head}${filler}\n【尾部独有标记-TAIL-END】`;
    mockProviderMultiRound([[{ type: 'text', content: fullText }, { type: 'done', finishReason: 'stop' }]]);

    await runTaskChatLoop(makeDispatchTaskConfig(CHAIN), makeConfig(), makeContext());

    const reply = terminalReply();
    expect(reply).toBeDefined();
    expect(reply!.task_id).toBe(CHAIN);
    // body 是引用形态：落盘说明 + 头部摘录 + 相对路径；不含尾部独有标记（未全量回传）
    expect(reply!.body).toContain('【结果过长已落盘】');
    expect(reply!.body).toContain('.momo-scratch/dispatch/T-spill-1.md');
    expect(reply!.body).toContain('# 完整分析报告');
    expect(reply!.body).not.toContain('【尾部独有标记-TAIL-END】');
    // 文件存在且内容 = 原文全文（PM 可 read_file 分页读取）
    const filePath = path.join(tmpRoot, '.momo-scratch', 'dispatch', `${CHAIN}.md`);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(fullText);
  });

  it('阈值内 → body 原样回传，不落盘', async () => {
    const CHAIN = 'T-spill-2';
    mockProviderMultiRound([[{ type: 'text', content: '简短结论' }, { type: 'done', finishReason: 'stop' }]]);

    await runTaskChatLoop(makeDispatchTaskConfig(CHAIN), makeConfig(), makeContext());

    const reply = terminalReply();
    expect(reply!.body).toBe('简短结论');
    expect(fs.existsSync(path.join(tmpRoot, '.momo-scratch', 'dispatch', `${CHAIN}.md`))).toBe(false);
  });

  it('spillDispatchBodyIfNeeded 单元：写盘失败（父路径是文件）→ 降级回原文', () => {
    const filePath = path.join(tmpRoot, 'not-a-dir-marker');
    fs.writeFileSync(filePath, 'x', 'utf8');
    const bigBody = 'y'.repeat(DISPATCH_BODY_SPILL_THRESHOLD_BYTES + 100);

    const out = spillDispatchBodyIfNeeded(bigBody, 'T-spill-3', filePath);
    // 落盘失败不丢回执：原文原样返回
    expect(out).toBe(bigBody);
  });

  it('B3 回归锁：task_id 含路径穿越字符 → 不作文件名（fallback 随机名），workspace 外零写入', () => {
    const evil = '../../../../etc/evil';
    const bigBody = 'z'.repeat(DISPATCH_BODY_SPILL_THRESHOLD_BYTES + 100);

    const out = spillDispatchBodyIfNeeded(bigBody, evil, tmpRoot);

    // 回执是引用形态，路径指向 fallback 安全名（不含穿越段）
    expect(out).toContain('【结果过长已落盘】');
    expect(out).not.toContain('../../../../');
    const m = /\.momo-scratch\/dispatch\/(unsafe-[a-f0-9-]+)\.md/.exec(out);
    expect(m).not.toBeNull();
    // 全文落在安全名文件里；evil 名文件不存在；workspace 上级无 evil 痕迹
    const safeFile = path.join(tmpRoot, '.momo-scratch', 'dispatch', `${m![1]}.md`);
    expect(fs.existsSync(safeFile)).toBe(true);
    expect(fs.readFileSync(safeFile, 'utf8')).toBe(bigBody);
    expect(fs.existsSync(path.join(tmpRoot, '.momo-scratch', 'dispatch', `${evil}.md`))).toBe(false);
  });
});
