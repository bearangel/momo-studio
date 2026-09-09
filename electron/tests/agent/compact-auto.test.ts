// electron/tests/agent/compact-auto.test.ts
//
// auto 阈值自动压缩回归锁（压缩改造 Task 5，spec §6.2）：真实 runChatLoop +
// fake LLM 剧本 + mock requestCompaction（IPC 副作用边界）。
// momo-test-rules：只 mock 进程/网络边界（LLM provider / compaction IPC），
// todo store / serialize / token 估算 / 尾部选择全部走真实实现。
//
// 用例（brief 四用例 + 错误路径专项）：
//   (a) 超阈值触发：请求前发生 compaction IPC（mock 收到 head 序列化——含大
//       消息、不含 prior 摘要条）；压缩后 messages 含「[历史压缩摘要]」且尾部
//       （当前 user 消息）verbatim 保留、大消息已被摘要替换
//   (b) 无 user 挂靠 → auto 压缩后 wrapUpMode（下一轮 tools undefined，机械收口）
//   (c) 有 user 挂靠 → synthetic「[系统] 上下文已自动压缩」续行消息存在且工具可用
//   (d) contextWindow=0（未知窗口）→ 不触发（mock 零调用，fail-safe）
//   (e) auto 压缩失败 → 不阻塞回合：messages 原样、工具可用、回合正常完成（spec §9）
//
// 构造说明：触发条件 est > MIN_TRIGGER(4000) 且尾部选择需要 head 非空（KEEP
// 预算 8000 内的对话全落尾部、无 head 可压）——历史里放一条 >8000 token 的
// CJK 大消息（20000 字 ÷1.6 ≈ 12500 token），尾部选择在其处截断。

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
import type { TodoItem } from '../../src/main/agent/tools/todo-types';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import { SkillRegistry } from '../../src/main/skill/registry';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

const SID = 'sid-auto';
const ROOM = 'room-auto';
/** CJK 大消息：20000 字 ÷1.6 ≈ 12500 token > KEEP(8000)——保证 head 非空 */
const BIG = '史'.repeat(20_000);
const MOCK_SUMMARY = '结构化摘要MOCK-目标与工作状态';

type Captured = { messages: LLMMessage[]; tools: LLMToolDef[] | undefined };
const captured: Captured[] = [];

type Scripted = { text?: string; toolCall?: { name: string; arguments: Record<string, unknown> } };
let script: Scripted[] = [];

/** 可配置会话历史（stub provider 返回——构造超阈值上下文的入口） */
let convHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

function installScriptedProvider(): void {
  vi.mocked(createLLMProvider).mockImplementation(() => ({
    chat: async () => ({ content: '', toolCalls: [], finishReason: 'stop' as const }),
    chatStream: async function* (
      messages: LLMMessage[],
      tools: LLMToolDef[] | undefined,
    ): AsyncGenerator<StreamDelta> {
      captured.push({ messages: [...messages], tools });
      const step = script.shift() ?? { text: '(完)' };
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
    // 压缩重构（T1）：0=未知窗口 → auto fail-safe 跳过；测试用例显式覆盖
    contextWindow: 0,
    outputTokens: 0,
    ...overrides,
  };
}

function mkCtx(): RuntimeContext {
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
    toolModules: [],
    creatorUserId: 'owner',
  };
}

function userTodo(subject: string): TodoItem {
  return { id: `u-${subject}`, subject, status: 'in_progress', source: 'user' };
}

/** 超阈值历史：prior 摘要注入条（T4 前缀）+ 一条 >KEEP 预算的 CJK 大消息 */
function bigHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
  return [
    { role: 'user', content: '[此前对话压缩摘要]\n旧摘要正文-PRIOR' },
    { role: 'assistant', content: BIG },
  ];
}

describe('auto 阈值自动压缩（spec §6.2）', () => {
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
    script = [];
    convHistory = [];
    __setTodosForTest(SID, []);
    vi.mocked(createLLMProvider).mockReset();
    installScriptedProvider();
    requestCompactionMock.mockReset();
    requestCompactionMock.mockResolvedValue(MOCK_SUMMARY);
    __setMemoryProviderForTest(stubProvider);
    process.send = ((_msg: unknown): boolean => true) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
  });

  it('(a) 超阈值触发：IPC 收到 head 序列化，压缩后含摘要条且尾部 verbatim 保留', async () => {
    convHistory = bigHistory();
    script = [{ text: '继续处理。' }];
    const out = await runChatLoop(
      ROOM, '请继续处理任务', mkConfig({ contextWindow: 1000 }), mkCtx(),
      undefined, undefined, undefined, SID,
    );
    // auto 压缩发生在首轮 LLM 请求前（refreshSystem 后检查）
    expect(requestCompactionMock).toHaveBeenCalledTimes(1);
    const [sessionId, conversation, coveredUntil] = requestCompactionMock.mock.calls[0] as unknown as [
      string, string, number,
    ];
    expect(sessionId).toBe(ROOM);
    expect(coveredUntil).toEqual(expect.any(Number));
    // head 序列化：含大消息（[助手] 前缀），跳过 prior 摘要条（防双重计入，T4 交接）
    expect(conversation).toContain('[助手]: ');
    expect(conversation).toContain(BIG);
    expect(conversation).not.toContain('旧摘要正文-PRIOR');
    // 压缩后：摘要条注入 + 尾部（当前 user 消息）verbatim 保留 + 大消息已被替换
    const round1 = JSON.stringify(captured[0]!.messages);
    expect(round1).toContain('[历史压缩摘要]');
    expect(round1).toContain(MOCK_SUMMARY);
    expect(round1).toContain('请继续处理任务');
    expect(round1).not.toContain(BIG);
    expect(out).toContain('继续处理');
  });

  it('(b) 无 user 挂靠 → wrapUpMode 机械收口（首轮即 tools undefined）', async () => {
    convHistory = bigHistory();
    script = [{ text: '已总结完毕。' }];
    const out = await runChatLoop(
      ROOM, '收尾任务', mkConfig({ contextWindow: 1000 }), mkCtx(),
      undefined, undefined, undefined, SID,
    );
    expect(requestCompactionMock).toHaveBeenCalledTimes(1);
    // 无挂靠 → 压缩后 wrapUpMode=true：下一轮（此处即当轮）LLM 请求无工具
    expect(captured[0]!.tools).toBeUndefined();
    const round1 = JSON.stringify(captured[0]!.messages);
    expect(round1).toContain('请输出简短总结后结束本轮');
    expect(JSON.stringify(captured)).not.toContain('继续工作');
    expect(out).toContain('已总结完毕');
  });

  it('(c) 有 user 挂靠 → synthetic 续行消息注入且工具可用', async () => {
    convHistory = bigHistory();
    __setTodosForTest(SID, [userTodo('分析数据-步骤1')]);
    script = [{ text: '收到，继续执行。' }];
    const out = await runChatLoop(
      ROOM, '帮我分析数据', mkConfig({ contextWindow: 1000 }), mkCtx(),
      undefined, undefined, undefined, SID,
    );
    expect(requestCompactionMock).toHaveBeenCalledTimes(1);
    // 有挂靠 → 不置收尾：工具照常下发的同时注入 [系统] 续行合成条
    expect(Array.isArray(captured[0]!.tools)).toBe(true);
    const round1 = JSON.stringify(captured[0]!.messages);
    expect(round1).toContain('[系统] 上下文已自动压缩');
    expect(round1).toContain('若仍有未完成的用户请求步骤');
    // mandate 段跨压缩存活（system 保留）
    expect(captured[0]!.messages[0]!.content).toContain('本轮用户授权');
    expect(out).toContain('继续执行');
  });

  it('(d) contextWindow=0（未知窗口）→ 不触发（mock 零调用，fail-safe）', async () => {
    convHistory = bigHistory();
    script = [{ text: '正常回复。' }];
    const out = await runChatLoop(
      ROOM, '普通消息', mkConfig({ contextWindow: 0 }), mkCtx(),
      undefined, undefined, undefined, SID,
    );
    expect(requestCompactionMock).not.toHaveBeenCalled();
    // 原上下文原样进入 LLM 请求
    expect(JSON.stringify(captured[0]!.messages)).toContain(BIG);
    expect(out).toContain('正常回复');
  });

  it('(e) auto 压缩失败 → 不阻塞回合：messages 原样、工具可用、正常完成（spec §9）', async () => {
    convHistory = bigHistory();
    requestCompactionMock.mockRejectedValue(new Error('压缩摘要生成为空，请重试'));
    script = [{ text: '降级继续回复。' }];
    const out = await runChatLoop(
      ROOM, '请继续处理任务', mkConfig({ contextWindow: 1000 }), mkCtx(),
      undefined, undefined, undefined, SID,
    );
    expect(requestCompactionMock).toHaveBeenCalledTimes(1);
    // 失败不阻塞：回合照常走完，messages 未被替换（大消息仍在）
    expect(Array.isArray(captured[0]!.tools)).toBe(true);
    expect(JSON.stringify(captured[0]!.messages)).toContain(BIG);
    expect(out).toContain('降级继续回复');
  });
});
