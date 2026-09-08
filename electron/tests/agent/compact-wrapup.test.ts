// electron/tests/agent/compact-wrapup.test.ts
//
// compact 双态回归锁（turn-mandate spec §5.1 / §7-2）：真实 runChatLoop + fake LLM。
// momo-test-rules：不 mock 被测单元内部，只 mock 外部副作用边界——
//   - LLM provider：vi.mock 工厂只引用 vi.fn()（沿用 runtime-entry-steer.test.ts 模式，
//     规避 brief 适配点 ① 的 hoisting 陷阱），剧本回放经 mockImplementation 注入
//   - 记忆 provider：__setMemoryProviderForTest 注入 stub（真实 memory 模块）
//
// 用例对应 spec §7-2 核心回归锁：
//   (a) 无 user 挂靠 → 压缩后下一轮 tools=undefined，回合机械终止（收尾模式）
//   (b) 有 user 挂靠 → 工具正常（续跑模式），mandate 段跨压缩存活
//   (c) 收尾模式下 drain 出 steer → 清除收尾、恢复工具（spec §5.1 交互）
//   (d) task 域（currentTaskId 非空）compact 行为不变：工具正常、不进收尾
//   (e) dispatch 子路径（parentStreamSessionId 非空）compact 不进收尾（contract 1 第三态）
//   (f) summary 过短 → 拒绝反馈回填 LLM 且不置收尾
//
// chunk 捕获说明：runChatLoop 的 tool_result 等 chunk 走模块级 sendStreamChunk
// （= process.send?.(chunk)），故经 process.send stub 收集到 sentChunks——
// 三态 tool_result 文案与「第二份指令消息已删」均在此断言（审查 Important 1）。
//
// brief 适配点 ②：真实 StreamDelta 的 text 增量字段是 content（llm-provider.ts），
// fake 剧本按 content 产出（brief 草稿的 delta 字段名以实际类型为准修正）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LLMMessage, LLMToolDef, StreamDelta } from '../../src/main/agent/llm-provider';

vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
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
const SUMMARY = 'x'.repeat(80); // ≥50 字符过 compact 校验

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

  beforeEach(() => {
    captured.length = 0;
    sentChunks.length = 0;
    script = [];
    __setTodosForTest(SID, []);
    vi.mocked(createLLMProvider).mockReset();
    installScriptedProvider();
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
      { toolCall: { name: 'compact', arguments: { summary: SUMMARY } } },
      { text: '已按要求压缩，本轮结束。' },
    ];
    const out = await runChatLoop('room-t', '压缩上下文', mkConfig(), mkCtx(), undefined, undefined, undefined, SID);
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
      { toolCall: { name: 'compact', arguments: { summary: SUMMARY } } },
      { text: '继续完成重构。' },
    ];
    const out = await runChatLoop('room-t', '帮我重构X模块', mkConfig(), mkCtx(), undefined, undefined, undefined, SID);
    expect(captured.length).toBe(2);
    expect(Array.isArray(captured[1]!.tools)).toBe(true);
    expect(out).toContain('继续完成重构');
    // 压缩后 messages[0] 仍含 mandate（system 保留，spec §2 跨压缩存活）
    const sys = captured[1]!.messages[0]!;
    expect(sys.role).toBe('system');
    expect(sys.content).toContain('本轮用户授权');
    // 尾部指令为续跑文案（仍有用户未完成项）
    const round2 = JSON.stringify(captured[1]!.messages);
    expect(round2).toContain('本轮仍有用户请求的未完成工作');
    expect(JSON.stringify(captured)).not.toContain('继续工作');
    // 续跑态 tool_result 文案：K=1（仍有 1 项用户待办，spec §5.6 #3）
    const results = compactToolResults();
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('仍有 1 项用户待办');
  });

  it('(c) 收尾模式下 drain 出 steer → 清除收尾、恢复工具（spec §5.1 交互）', async () => {
    script = [
      // 无 user 挂靠：compact 置 wrapUpMode=true；done 后注入 steer → 下一轮 drain 清除
      { toolCall: { name: 'compact', arguments: { summary: SUMMARY } }, emitSteer: '请追加检查 Y' },
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
      { toolCall: { name: 'compact', arguments: { summary: SUMMARY } } },
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

  it('(e) dispatch 子路径（parentStreamSessionId 非空）compact 不进收尾：工具正常 + task 域中性文案', async () => {
    script = [
      { toolCall: { name: 'compact', arguments: { summary: SUMMARY } } },
      { text: '子任务继续。' },
    ];
    // 8 参调用形态：第 6 参 parentStreamSessionId 非空 = dispatch 子 agent；
    // streamSessionIdOverride 仍传 SID（override 优先级高于 parent，todo 键控不变）
    await runChatLoop('room-t', '子任务正文', mkConfig(), mkCtx(), undefined, 'pm-sid-1', undefined, SID);
    expect(captured.length).toBe(2);
    expect(Array.isArray(captured[1]!.tools)).toBe(true);
    // 尾部指令与 tool_result 均走 task 域中性文案（contract 第三态）
    const round2 = JSON.stringify(captured[1]!.messages);
    expect(round2).toContain('请基于总结继续当前任务');
    const results = compactToolResults();
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('请基于总结继续当前任务');
  });

  it('(f) summary 过短 → 拒绝反馈回填 LLM 且不置收尾（下一轮工具正常）', async () => {
    script = [
      { toolCall: { name: 'compact', arguments: { summary: '太短' } } },
      { text: '好的，重写完整总结。' },
    ];
    await runChatLoop('room-t', '压缩上下文', mkConfig(), mkCtx(), undefined, undefined, undefined, SID);
    expect(captured.length).toBe(2);
    // 拒绝反馈：回填 LLM 的 tool 消息含「过短」（< 50 字符校验）
    const round2 = JSON.stringify(captured[1]!.messages);
    expect(round2).toContain('过短');
    // 失败的 compact 不得置收尾——下一轮工具照常（wrapUpMode 仍为 false）
    expect(Array.isArray(captured[1]!.tools)).toBe(true);
  });
});
