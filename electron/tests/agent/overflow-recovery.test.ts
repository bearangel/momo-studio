// electron/tests/agent/overflow-recovery.test.ts
//
// 溢出恢复 + 重放 + 防循环回归锁（压缩改造 Task 6，spec §7 + T5 遗留 Important-1）：
// 真实 runChatLoop + fake LLM 剧本（含 throwError 能力）+ mock requestCompaction
// （IPC 副作用边界）。momo-test-rules：只 mock 进程/网络边界（LLM provider /
// compaction IPC），todo store / serialize / token 估算 / 尾部选择全走真实实现。
//
// 用例：
//   (a)  首轮溢出 → 压缩 IPC 恰 1 次 + 摘要条注入 + 重放 mandate.userBody
//        （末条 verbatim）+ 工具恢复（恢复=重试本轮而非收尾）+ 回合正常完成
//   (a2) steers 参与重放：userBody + steer 逐条 push 为 user 消息；steer 不回写
//        mandate.steers（system 授权提示段只出现一次——重放≠再授权）
//   (b)  二次溢出 → 按原错误路径终止（end chunk error 形态）+ IPC 仍仅 1 次（防循环）
//   (c1) coveredUntil 精确化（T5 Important-1）：head 末条为 convCtx 来源 → IPC
//        请求的 coveredUntil === 该消息的精确 DB timestamp（旧实现 Date.now() 红）
//   (c2) head 末条为回合内消息 → coveredUntil === turnStart - 1（回合内消息
//        createdAt ≥ turnStart，恒安全；fake timers 冻结区分旧值）
//   (d)  非 overflow 错误（'network error'）→ 直接终止不压缩（regex 不过匹配锁）
//   (e)  恢复压缩失败 → 按原溢出错误终止（不吞不改），IPC 1 次
//
// abort 分支优先级不变（既有 abort 套件覆盖，此处不重复）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LLMMessage, LLMToolDef, StreamDelta } from '../../src/main/agent/llm-provider';

vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

const { requestCompactionMock } = vi.hoisted(() => ({
  requestCompactionMock: vi.fn(),
}));

// IPC 副作用边界 mock（momo-test-rules 铁律 5）：尾部选择/序列化/估算走真实实现
vi.mock('../../src/main/agent/compaction-ipc', () => ({
  requestCompaction: requestCompactionMock,
  handleCompactionResultIpc: vi.fn(),
  COMPACTION_REQUEST_TIMEOUT_MS: 10_000,
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import { runChatLoop, type RuntimeContext } from '../../src/main/agent/runtime-entry';
import { __setTodosForTest } from '../../src/main/agent/tools/todo-tools';
import type { ContextMessage } from '../../src/main/memory';
import type { ToolModule } from '../../src/main/agent/tools/types';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import { SkillRegistry } from '../../src/main/skill/registry';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

const SID = 'sid-overflow';
const ROOM = 'room-overflow';
/** provider 溢出错误样例（OpenAI/Anthropic 上下文超限的典型措辞） */
const OVERFLOW_MSG = 'Request too large: maximum context length exceeded';
/** CJK 大消息：20000 字 ÷1.6 ≈ 12500 token > KEEP(8000)——保证 head 非空 */
const BIG = '史'.repeat(20_000);
/** convCtx 大消息的精确 DB createdAt（c1 断言值——任何 Date.now() 都不等于它） */
const T_BIG = 1_712_345_678_000;
const MOCK_SUMMARY = '结构化摘要MOCK-目标与工作状态';

type Captured = { messages: LLMMessage[]; tools: LLMToolDef[] | undefined };
const captured: Captured[] = [];
/** process.send 捕获（end chunk 形态断言） */
const sentChunks: Array<Record<string, unknown>> = [];

type Scripted = {
  text?: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
  /** 本轮 chatStream 直接 throw（溢出/网络错误剧本） */
  throwError?: string;
  /** done 产出后（工具循环处理前）emit steer——下一轮 loop 顶部 drain 消费 */
  emitSteer?: string;
};
let script: Scripted[] = [];

/** 可配置会话历史（ContextMessage 全形状——timestamp 参与 coveredUntil 计算） */
let convHistory: ContextMessage[] = [];

function installScriptedProvider(): void {
  vi.mocked(createLLMProvider).mockImplementation(() => ({
    chat: async () => ({ content: '', toolCalls: [], finishReason: 'stop' as const }),
    chatStream: async function* (
      messages: LLMMessage[],
      tools: LLMToolDef[] | undefined,
    ): AsyncGenerator<StreamDelta> {
      captured.push({ messages: [...messages], tools });
      const step = script.shift() ?? { text: '(完)' };
      if (step.throwError !== undefined) {
        throw new Error(step.throwError);
      }
      if (step.toolCall) {
        yield {
          type: 'tool_use',
          toolCall: {
            id: `call-${captured.length}`,
            name: step.toolCall.name,
            arguments: step.toolCall.arguments,
          },
        };
        yield { type: 'done', finishReason: 'tool_use' };
        if (step.emitSteer !== undefined) {
          process.emit('message', { type: 'steer', streamSessionId: SID, body: step.emitSteer });
        }
      } else {
        yield { type: 'thinking', content: '' };
        yield { type: 'text', content: step.text ?? '' };
        yield { type: 'done', finishReason: 'stop' };
      }
    },
  }));
}

function mkConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-t',
    agentUserId: 'agent-t',
    systemPrompt: 'BASE-CONFIG',
    modelName: 'test-model',
    llmApiKey: 'k',
    workspaceDir: '/tmp',
    workspaceId: 'ws-t',
    role: 'standalone',
    subAgents: [],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: false,
    devMode: false,
    maxToolCalls: 10,
    // 溢出恢复不依赖窗口配置（恢复路径独立于 auto fail-safe）；auto 用例显式覆盖
    contextWindow: 0,
    outputTokens: 0,
    ...overrides,
  };
}

function mkCtx(overrides: { toolModules?: ToolModule[] } = {}): RuntimeContext {
  return {
    wsFs: {} as RuntimeContext['wsFs'],
    skillRegistry: new SkillRegistry(),
    tools: [],
    systemPrompt: 'BASE',
    workspaceId: 'ws-t',
    workspaceDir: '/tmp',
    roomId: ROOM,
    streamSessionId: SID,
    sendStreamChunk: () => {},
    toolModules: overrides.toolModules ?? [],
    creatorUserId: 'owner',
  };
}

/** 测试专用工具模块：返回固定大结果（构造回合内消息预算边界用） */
const bigToolModule: ToolModule = {
  getDefs: () => [
    { name: 'big_tool', description: '测试专用：返回大结果', inputSchema: { type: 'object', properties: {} } },
  ],
  handles: (name) => name === 'big_tool',
  execute: async () => '果'.repeat(1_600),
};

/** end chunk 过滤（finishReason 形态断言入口） */
function endChunks(): Array<Record<string, unknown>> {
  return sentChunks.filter((c) => c.type === 'end');
}

/** 带 prior 摘要注入条 + 大消息的会话历史（timestamp 全形状） */
function bigHistory(): ContextMessage[] {
  return [
    {
      role: 'user',
      content: '[此前对话压缩摘要]\n旧摘要正文-PRIOR',
      timestamp: 1_000,
      sender: 'owner',
    },
    { role: 'assistant', content: BIG, timestamp: T_BIG, sender: 'agent-coder' },
  ];
}

describe('溢出恢复 + 重放 + 防循环（spec §7 + T5 Important-1）', () => {
  const originalSend = process.send;

  const stubProvider: MemoryProvider = {
    getTaskContext: async () => null,
    getConversationContext: async () => ({ messages: convHistory }),
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

  beforeEach(() => {
    captured.length = 0;
    sentChunks.length = 0;
    script = [];
    convHistory = [];
    __setTodosForTest(SID, []);
    vi.mocked(createLLMProvider).mockReset();
    installScriptedProvider();
    requestCompactionMock.mockReset();
    requestCompactionMock.mockResolvedValue(MOCK_SUMMARY);
    __setMemoryProviderForTest(stubProvider);
    process.send = ((msg: unknown): boolean => {
      sentChunks.push(msg as Record<string, unknown>);
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
    vi.useRealTimers();
  });

  it('(a) 首轮溢出 → 压缩一次 + 摘要条 + 重放 userBody（末条）+ 回合继续到完成', async () => {
    convHistory = bigHistory();
    script = [
      { throwError: OVERFLOW_MSG },
      { text: '已恢复，继续完成任务。' },
    ];
    const out = await runChatLoop(
      ROOM, '帮我分析这批数据', mkConfig(), mkCtx(),
      undefined, undefined, undefined, SID,
    );
    // 压缩恰发生一次
    expect(requestCompactionMock).toHaveBeenCalledTimes(1);
    // 恢复轮（第二次 LLM 请求）：摘要条注入 + 大消息已被摘要替换
    expect(captured.length).toBe(2);
    const recovered = captured[1]!.messages;
    const recoveredJson = JSON.stringify(recovered);
    expect(recoveredJson).toContain('[历史压缩摘要]');
    expect(recoveredJson).toContain(MOCK_SUMMARY);
    expect(recoveredJson).not.toContain(BIG);
    // 重放的本轮授权：末条 user 消息 = mandate.userBody verbatim
    const last = recovered[recovered.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.content).toBe('帮我分析这批数据');
    // 恢复 = 重试本轮（清收尾模式）——工具可用，而非机械收口
    expect(Array.isArray(captured[1]!.tools)).toBe(true);
    // 回合继续到完成：正常终文 + end(stop)
    expect(out).toContain('已恢复');
    const ends = endChunks();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ type: 'end', finishReason: 'stop' });
  });

  it('(a2) steers 参与重放：userBody + steer 逐条 push，且不回写 mandate.steers（提示段不翻倍）', async () => {
    convHistory = bigHistory();
    script = [
      { toolCall: { name: 'big_tool', arguments: {} }, emitSteer: '补充要求A' },
      { throwError: OVERFLOW_MSG },
      { text: '已完成。' },
    ];
    await runChatLoop(
      ROOM, '处理任务X', mkConfig(), mkCtx({ toolModules: [bigToolModule] }),
      undefined, undefined, undefined, SID,
    );
    expect(requestCompactionMock).toHaveBeenCalledTimes(1);
    expect(captured.length).toBe(3);
    const recovered = captured[2]!.messages;
    // 重放顺序：userBody 后跟 steer（与原注入形态一致，[用户中途补充] 前缀）
    const last = recovered[recovered.length - 1]!;
    const secondLast = recovered[recovered.length - 2]!;
    expect(last.role).toBe('user');
    expect(last.content).toBe('[用户中途补充] 补充要求A');
    expect(secondLast.role).toBe('user');
    expect(secondLast.content).toBe('处理任务X');
    // 「重放≠再授权」：steer 文本全程恰 3 次——system 授权提示段 1 次 + 尾部
    // 原 drain 注入 1 次 + 重放消息 1 次。若误回写 mandate.steers，提示段变 2 次。
    const occurrences = (JSON.stringify(recovered).match(/补充要求A/g) ?? []).length;
    expect(occurrences).toBe(3);
  });

  it('(b) 二次溢出 → 按原错误路径终止（end error）+ IPC 仍仅 1 次（防循环）', async () => {
    convHistory = bigHistory();
    script = [
      { throwError: OVERFLOW_MSG },
      { throwError: OVERFLOW_MSG },
    ];
    await expect(
      runChatLoop(
        ROOM, '帮我分析这批数据', mkConfig(), mkCtx(),
        undefined, undefined, undefined, SID,
      ),
    ).rejects.toThrow('maximum context length');
    // 防循环：恢复只发生一次，第二次溢出直接终止
    expect(requestCompactionMock).toHaveBeenCalledTimes(1);
    expect(captured.length).toBe(2);
    // end chunk error 形态（错误信息为原始溢出错误）
    const ends = endChunks();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      type: 'end',
      finishReason: 'error',
      error: expect.stringContaining('maximum context length'),
    });
  });

  it('(c1) coveredUntil 精确化：head 末条为 convCtx 来源 → === 该消息 DB timestamp', async () => {
    convHistory = [
      { role: 'assistant', content: BIG, timestamp: T_BIG, sender: 'agent-coder' },
    ];
    script = [{ text: '好的。' }];
    await runChatLoop(
      ROOM, '继续任务', mkConfig({ contextWindow: 1000 }), mkCtx(),
      undefined, undefined, undefined, SID,
    );
    expect(requestCompactionMock).toHaveBeenCalledTimes(1);
    const [sessionId, , coveredUntil] = requestCompactionMock.mock.calls[0] as unknown as [
      string, string, number,
    ];
    expect(sessionId).toBe(ROOM);
    // head = [BIG]（convCtx 来源）→ coveredUntil 是其精确落库时刻，
    // 不是压缩时刻 Date.now()（旧实现过覆盖：下轮收缩误过滤未摘要的尾部消息）
    expect(coveredUntil).toBe(T_BIG);
  });

  it('(c2) coveredUntil 精确化：head 末条为回合内消息 → turnStart - 1（< 回合内任何落库时刻）', async () => {
    // 回合内 head 末条构造（沿 compact-auto (f)：大参数工具调用 + steer 锚点）：
    // round1 big_tool（assistant 挂大参数）→ steer drain 为末位真实 user（锚点）
    // → round2 顶部 auto 压缩：预算切点把当前 user 消息留在 head（末条回合内）。
    const FROZEN = 1_700_000_000_000;
    vi.useFakeTimers({ now: FROZEN });
    try {
      convHistory = [];
      script = [
        { toolCall: { name: 'big_tool', arguments: { payload: '参'.repeat(12_000) } }, emitSteer: '继续推进数据分析' },
        { text: '收到，继续。' },
      ];
      await runChatLoop(
        ROOM, '请处理大数据任务', mkConfig({ contextWindow: 1000 }),
        mkCtx({ toolModules: [bigToolModule] }),
        undefined, undefined, undefined, SID,
      );
    } finally {
      vi.useRealTimers();
    }
    expect(requestCompactionMock).toHaveBeenCalledTimes(1);
    const [, conversation, coveredUntil] = requestCompactionMock.mock.calls[0] as unknown as [
      string, string, number,
    ];
    // head 末条 = 当前 user 消息（回合内）→ turnStart - 1（冻结时钟下恰为
    // FROZEN-1；旧实现 Date.now()=FROZEN 会覆盖 ≥ turnStart 的回合内消息）
    expect(coveredUntil).toBe(FROZEN - 1);
    // head 序列化确实包含该回合内 user 消息（确认 coveredUntil 指向的就是它）
    expect(conversation).toContain('请处理大数据任务');
  });

  it('(d) 非 overflow 错误 → 直接终止不压缩（特征匹配不过拟合）', async () => {
    convHistory = bigHistory();
    script = [{ throwError: 'network error' }];
    await expect(
      runChatLoop(
        ROOM, '帮我分析这批数据', mkConfig(), mkCtx(),
        undefined, undefined, undefined, SID,
      ),
    ).rejects.toThrow('network error');
    expect(requestCompactionMock).not.toHaveBeenCalled();
    const ends = endChunks();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ type: 'end', finishReason: 'error', error: 'network error' });
  });

  it('(e) 恢复压缩失败 → 按原溢出错误终止（错误路径专项，不吞不改）', async () => {
    convHistory = bigHistory();
    requestCompactionMock.mockRejectedValue(new Error('压缩摘要生成为空，请重试'));
    script = [
      { throwError: OVERFLOW_MSG },
      { text: '不应到达' },
    ];
    await expect(
      runChatLoop(
        ROOM, '帮我分析这批数据', mkConfig(), mkCtx(),
        undefined, undefined, undefined, SID,
      ),
    ).rejects.toThrow('maximum context length');
    expect(requestCompactionMock).toHaveBeenCalledTimes(1);
    // 终止错误是原始溢出错误（不是压缩失败错误——恢复失败不遮蔽病因）
    const ends = endChunks();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      type: 'end',
      finishReason: 'error',
      error: expect.stringContaining('maximum context length'),
    });
    expect(ends[0]!.error).not.toContain('压缩摘要生成为空');
  });
});
