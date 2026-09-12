// electron/tests/agent/compact-wrapup.test.ts
//
// compact 双态回归锁（turn-mandate spec §5.1 / §7-2 + 压缩改造 spec §6.1）：真实
// runChatLoop + fake LLM。momo-test-rules：不 mock 被测单元内部，只 mock 外部
// 副作用边界——
//   - LLM provider：vi.mock 工厂只引用 vi.fn()（沿用 runtime-entry-steer.test.ts
//     模式，规避 brief 适配点 ① 的 hoisting 陷阱），剧本回放经 mockImplementation 注入
//   - 记忆 provider：__setMemoryProviderForTest 注入 stub（真实 memory 模块）
//   - compaction IPC：vi.mock compaction-ipc（Task 5 迁出后的副作用边界），
//     requestCompaction 固定返回摘要——尾部选择/序列化/双态判定全走真实实现
//
// 用例对应 spec §7-2 核心回归锁（Task 5 适配：工具无 summary 参数、历史需构造
// >KEEP 预算大消息使 head 非空——否则尾部选择吞掉全部消息、无 head 可压）：
//   (a) 无 user 挂靠 → 压缩后下一轮 tools=undefined，回合机械终止（收尾模式）
//   (b) 有 user 挂靠 → 工具正常（续跑模式），mandate 段跨压缩存活
//   (c) 收尾模式下 drain 出 steer → 清除收尾、恢复工具（spec §5.1 交互）
//   (d) task 域（currentTaskId 非空）compact 行为不变：工具正常、不进收尾
//   (e) dispatch 子路径（parentStreamSessionId 非空）compact 不进收尾（第三态）
//   (f) 压缩请求失败 → 报错反馈回填 LLM、messages 原样、不置收尾（可重试）
//
// chunk 捕获说明：runChatLoop 的 tool_result 等 chunk 走模块级 sendStreamChunk
// （= process.send?.(chunk)），故经 process.send stub 收集到 sentChunks——
// 三态 tool_result 文案与「第二份指令消息已删」均在此断言（审查 Important 1）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LLMMessage, LLMToolDef, StreamDelta } from '../../src/main/agent/llm-provider';

vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

const { requestCompactionMock } = vi.hoisted(() => ({
  requestCompactionMock: vi.fn(),
}));

// IPC 副作用边界 mock：固定返回摘要文本（主进程 CompactionService 行为不在本锁范围）
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

const SID = 'sid-wrap';
const MOCK_SUMMARY = 'WRAPUP-结构化摘要正文';
/** CJK 大消息：20000 字 ÷1.6 ≈ 12500 token > KEEP(8000)——保证 head 非空可压 */
const BIG = '史'.repeat(20_000);

// —— 捕获每轮 LLM 请求的 messages/tools，按剧本回放（brief harness 语义） ——
type Captured = { messages: LLMMessage[]; tools: LLMToolDef[] | undefined };
const captured: Captured[] = [];

// —— 捕获 runChatLoop 发出的 stream chunk（经 process.send stub 收集） ——
const sentChunks: unknown[] = [];

/** 从 sentChunks 过滤 compact 的 tool_result 文案（三态文案断言用） */
function compactToolResults(): string[] {
  return sentChunks
    .filter(
      (c): c is { type: 'tool_result'; toolName: string; result: string } =>
        typeof c === 'object' &&
        c !== null &&
        (c as { type?: string }).type === 'tool_result' &&
        (c as { toolName?: string }).toolName === 'compact',
    )
    .map((c) => c.result);
}

/**
 * 剧本步骤：
 *   - toolCall：本轮回放一次工具调用（compact/task_complete 为内联工具，无需注册表）
 *   - text：本轮回放 thinking + text + done(stop)，回合自然结束
 *   - emitSteer：done 产出后（compact 内联处理前）emit steer 消息——
 *     复刻 runtime-entry-steer.test.ts 的注入时机：下一轮 loop 顶部 drain 消费
 */
type Scripted = {
  text?: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
  emitSteer?: string;
};
let script: Scripted[] = [];

/** 可配置会话历史（stub provider 返回——默认放一条大消息使 head 非空） */
let convHistory: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number; sender: string }> = [];

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
        if (step.emitSteer !== undefined) {
          (process.emit as (event: string, ...args: unknown[]) => boolean)('message', { type: 'steer', streamSessionId: SID, body: step.emitSteer });
        }
      } else {
        yield { type: 'thinking', content: '' };
        yield { type: 'text', content: step.text ?? '' };
        yield { type: 'done', finishReason: 'stop' };
      }
    },
  }));
}

/** 以 runtime-config.ts 的 RuntimeConfig 接口为准的完整最小实例 */
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
    // 压缩重构（T1）：0=未知窗口 → auto 路径 fail-safe 关闭，本锁只测工具触发路径
    contextWindow: 0,
    outputTokens: 0,
    ...overrides,
  };
}

/** RuntimeContext 最小实例——compact/task_complete 为内联工具，toolModules 可为空 */
function mkCtx(): RuntimeContext {
  return {
    wsFs: {} as RuntimeContext['wsFs'],
    skillRegistry: new SkillRegistry(),
    tools: [],
    systemPrompt: 'BASE',
    workspaceId: 'ws-t',
    workspaceDir: '/tmp',
    roomId: 'room-t',
    streamSessionId: SID,
    sendStreamChunk: () => {},
    toolModules: [],
    creatorUserId: 'owner',
  };
}

function userTodo(subject: string): TodoItem {
  return { id: `u-${subject}`, subject, status: 'in_progress', source: 'user' };
}

describe('compact 双态（chat 路径，spec §5.1/§7-2）', () => {
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
    // 默认历史：一条 >KEEP 预算的 CJK 大消息（head 非空，压缩有物可压）
    convHistory = [{ role: 'assistant', content: BIG, timestamp: 1, sender: 'bot' }];
    __setTodosForTest(SID, []);
    vi.mocked(createLLMProvider).mockReset();
    installScriptedProvider();
    requestCompactionMock.mockReset();
    requestCompactionMock.mockResolvedValue(MOCK_SUMMARY);
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

  it('(a) 无 user 挂靠 → 压缩后下一轮 tools=undefined，回合终止（收尾模式）', async () => {
    script = [
      { toolCall: { name: 'compact', arguments: { note: '用户要求压缩' } } },
      { text: '已按要求压缩，本轮结束。' },
    ];
    const out = await runChatLoop('room-t', '压缩上下文', mkConfig(), mkCtx(), undefined, undefined, undefined, SID);
    expect(requestCompactionMock).toHaveBeenCalledTimes(1);
    expect(captured.length).toBe(2);
    // 本特性的核心机械保证：收尾轮不携带任何工具（断言不得弱化）
    expect(captured[1]!.tools).toBeUndefined();
    expect(out).toContain('本轮结束');
    // 尾部指令为收尾文案，且全程无「继续工作」类前进指令（spec §5.6 #2/#3）
    const round2 = JSON.stringify(captured[1]!.messages);
    expect(round2).toContain('请输出简短总结后结束本轮');
    expect(JSON.stringify(captured)).not.toContain('继续工作');
    // 第二份前进指令消息已删（spec §5.6 #4）：round-2 恰 1 条 role=tool 消息，
    // 且不含旧实现回填的「请继续基于总结工作」
    expect(captured[1]!.messages.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(round2).not.toContain('请继续基于总结工作');
    // 收尾态 tool_result 文案（spec §5.6 #3）
    const results = compactToolResults();
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('无用户待办，请输出总结收尾');
  });

  it('(b) 有 user 挂靠 → 压缩后工具正常（续跑模式），mandate 段跨压缩存活', async () => {
    __setTodosForTest(SID, [userTodo('重构X模块-步骤1')]);
    script = [
      { toolCall: { name: 'compact', arguments: {} } },
      { text: '继续完成重构。' },
    ];
    const out = await runChatLoop('room-t', '帮我重构X模块', mkConfig(), mkCtx(), undefined, undefined, undefined, SID);
    expect(requestCompactionMock).toHaveBeenCalledTimes(1);
    expect(captured.length).toBe(2);
    expect(Array.isArray(captured[1]!.tools)).toBe(true);
    expect(out).toContain('继续完成重构');
    // 压缩后 messages[0] 仍含 mandate（system 保留，spec §2 跨压缩存活）
    const sys = captured[1]!.messages[0]!;
    expect(sys.role).toBe('system');
    expect(sys.content).toContain('本轮用户授权');
    // 尾部指令为续跑文案（仍有用户未完成项），尾部（当前 user 消息）verbatim 保留
    const round2 = JSON.stringify(captured[1]!.messages);
    expect(round2).toContain('本轮仍有用户请求的未完成工作');
    expect(round2).toContain('帮我重构X模块');
    expect(round2).toContain(MOCK_SUMMARY);
    expect(round2).not.toContain(BIG);
    expect(JSON.stringify(captured)).not.toContain('继续工作');
    // 续跑态 tool_result 文案：K=1（仍有 1 项用户待办，spec §5.6 #3）
    const results = compactToolResults();
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('仍有 1 项用户待办');
  });

  it('(c) 收尾模式下 drain 出 steer → 清除收尾、恢复工具（spec §5.1 交互）', async () => {
    script = [
      // 无 user 挂靠：compact 置 wrapUpMode=true；done 后注入 steer → 下一轮 drain 清除
      { toolCall: { name: 'compact', arguments: {} }, emitSteer: '请追加检查 Y' },
      { text: '收到补充，先处理 Y。' },
    ];
    const out = await runChatLoop('room-t', '压缩上下文', mkConfig(), mkCtx(), undefined, undefined, undefined, SID);
    expect(captured.length).toBe(2);
    // steer 优先于收尾：收尾曾置位但被 drain 清除 → 工具恢复
    expect(Array.isArray(captured[1]!.tools)).toBe(true);
    // 补充以 [用户中途补充] user message 注入（v2.3 drain 路径不因收尾模式旁路）
    const round2 = JSON.stringify(captured[1]!.messages);
    expect(round2).toContain('[用户中途补充] 请追加检查 Y');
    expect(out).toContain('先处理 Y');
  });

  it('(d) task 域（currentTaskId 非空）compact 行为不变：工具正常、不进收尾', async () => {
    const cfg = mkConfig({ currentTaskId: 'T-001' });
    script = [
      { toolCall: { name: 'compact', arguments: {} } },
      { text: '任务继续。' },
    ];
    const out = await runChatLoop('room-t', '任务正文', cfg, mkCtx(), undefined, undefined, undefined, SID);
    expect(captured.length).toBe(2);
    expect(Array.isArray(captured[1]!.tools)).toBe(true);
    expect(out).toContain('任务继续');
    // task 域中性文案（spec 非目标：任务执行域 compact 语义不变），不进收尾指令
    const round2 = JSON.stringify(captured[1]!.messages);
    expect(round2).toContain('请基于总结继续当前任务');
    expect(JSON.stringify(captured)).not.toContain('继续工作');
  });

  it('(e) dispatch 子路径（parentStreamSessionId 非空）compact 不进收尾：fresh 会话无 head → 无操作化，上下文原样、工具正常', async () => {
    script = [
      { toolCall: { name: 'compact', arguments: {} } },
      { text: '子任务继续。' },
    ];
    // 8 参调用形态：第 6 参 parentStreamSessionId 非空 = dispatch 子 agent；
    // streamSessionIdOverride 仍传 SID（override 优先级高于 parent，todo 键控不变）。
    // 压缩改造后契约：子 agent 是 fresh 会话（convCtx 恒空），当前 user 消息即
    // body[0]——mandate 锚点保护（spec §6.1「不得切断当前 user 消息」）使尾部
    // 覆盖全部消息、head 为空 → compact 无操作化（不发 IPC），绝不能据此进收尾。
    await runChatLoop('room-t', '子任务正文', mkConfig(), mkCtx(), undefined, 'pm-sid-1', undefined, SID);
    expect(requestCompactionMock).not.toHaveBeenCalled();
    expect(captured.length).toBe(2);
    // 不进收尾（本用例核心不变式）：下一轮工具照常
    expect(Array.isArray(captured[1]!.tools)).toBe(true);
    // 无操作化：上下文原样（无摘要条、任务正文 verbatim 保留）
    const round2 = JSON.stringify(captured[1]!.messages);
    expect(round2).not.toContain('[历史压缩摘要]');
    expect(round2).toContain('子任务正文');
    // 无 head 的 compact 仍向 renderer 回执 tool_result（不静默吞）
    const results = compactToolResults();
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('无可压缩的更早历史');
  });

  it('(f) 压缩请求失败 → 报错反馈回填 LLM、messages 原样、不置收尾（可重试）', async () => {
    requestCompactionMock.mockRejectedValue(new Error('压缩摘要生成为空，请重试'));
    script = [
      { toolCall: { name: 'compact', arguments: {} } },
      { text: '好的，稍后重试压缩。' },
    ];
    await runChatLoop('room-t', '压缩上下文', mkConfig(), mkCtx(), undefined, undefined, undefined, SID);
    expect(requestCompactionMock).toHaveBeenCalledTimes(1);
    expect(captured.length).toBe(2);
    // 失败反馈：回填 LLM 的 tool 消息含「压缩失败」与可重试提示
    const round2 = JSON.stringify(captured[1]!.messages);
    expect(round2).toContain('压缩失败');
    expect(round2).toContain('可重试');
    // messages 原样：历史大消息未被替换（spec §6.1 #5 失败不动上下文）
    expect(round2).toContain(BIG);
    expect(round2).not.toContain('[历史压缩摘要]');
    // 失败的 compact 不得置收尾——下一轮工具照常（wrapUpMode 仍为 false）
    expect(Array.isArray(captured[1]!.tools)).toBe(true);
  });
});
