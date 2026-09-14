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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

// mock electron：stream-relay 生产落库链在测试环境静默降级
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import { runChatLoop, type RuntimeContext } from '../../src/main/agent/runtime-entry';
import { __setTodosForTest } from '../../src/main/agent/tools/todo-tools';
import type { TodoItem } from '../../src/main/agent/tools/todo-types';
import type { ToolModule } from '../../src/main/agent/tools/types';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import { SkillRegistry } from '../../src/main/skill/registry';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';
import {
  __routeChunkToBufferForTest,
  __resetEventBufferForTest,
  __flushEventBufferForTest,
} from '../../src/main/agent/stream-relay';

const SID = 'sid-auto';
const ROOM = 'room-auto';
/** CJK 大消息：20000 字 ÷1.6 ≈ 12500 token > KEEP(8000)——保证 head 非空 */
const BIG = '史'.repeat(20_000);
/** 工具结果：1600 字 ÷1.6 = 1000 token（入尾部） */
const BIG_TOOL_RESULT = '果'.repeat(1_600);
/** 工具调用参数：12000 字 ÷1.6 = 7500 token——挂在 assistant 消息上（预算累计后
 * 恰好使切点落在 assistant 与其 tool 结果之间：1000+6 ≤ 8000 < 1006+7502） */
const BIG_TOOL_ARGS = '参'.repeat(12_000);
const MOCK_SUMMARY = '结构化摘要MOCK-目标与工作状态';

type Captured = { messages: LLMMessage[]; tools: LLMToolDef[] | undefined };
const captured: Captured[] = [];

type Scripted = {
  text?: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
  /** done 产出后（工具循环处理前）emit steer——下一轮 loop 顶部 drain 消费 */
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

function userTodo(subject: string): TodoItem {
  return { id: `u-${subject}`, subject, status: 'in_progress', source: 'user' };
}

/** 测试专用工具模块：返回固定大结果（构造 tool/assistant 预算边界用） */
const bigToolModule: ToolModule = {
  getDefs: () => [
    { name: 'big_tool', description: '测试专用：返回大结果', inputSchema: { type: 'object', properties: {} } },
  ],
  handles: (name) => name === 'big_tool',
  execute: async () => BIG_TOOL_RESULT,
};

/**
 * 孤儿 tool 消息扫描（审查 Critical 回归锁）：遍历 messages，每条 role='tool'
 * 的 toolCallId 必须能在其前方某条 assistant.toolCalls 中找到——否则该 tool
 * 消息孤立出现，OpenAI/Anthropic 请求体均硬性 400。
 */
function assertNoOrphanToolMessages(messages: LLMMessage[]): void {
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) seen.add(tc.id);
    }
    if (m.role === 'tool') {
      expect(seen.has(m.toolCallId ?? '__orphan__')).toBe(true);
    }
  }
}

// —— 会话连续性 B 段新契约：conv 历史经生产落库链 seed 进真实 DB ——
// （顶层路径 convCtx 已切 rebuildSessionContext；stub getConversationContext 闲置）
const tmpRoot = path.join(os.tmpdir(), `ap-compact-auto-${Date.now()}`);

/** 会话/工作区行（session_compactions 有 FK → sessions，compaction seed 前置） */
function seedSessionRow(): void {
  getDb().prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws-ca', 'WS', '', '/tmp', 0, '@owner:s', 'x')`,
  ).run();
  getDb().prepare(
    `INSERT INTO sessions (id, workspace_id, title, kind, created_at, updated_at)
     VALUES (?, 'ws-ca', 't', 'chat', 1000, 1000)`,
  ).run(ROOM);
}

/** 单条 text 流族（生产链 start → text → end；事件时刻显式归位保证时序确定） */
function seedTextFamily(ssi: string, text: string, ts: number): void {
  __routeChunkToBufferForTest({
    type: 'start', streamSessionId: ssi, sessionId: ROOM, senderAgentId: 'agent-ca',
  });
  __flushEventBufferForTest();
  getDb().prepare('UPDATE messages SET created_at = ? WHERE stream_session_id = ?').run(ts, ssi);
  __routeChunkToBufferForTest({ type: 'text', streamSessionId: ssi, delta: text });
  __flushEventBufferForTest();
  getDb().prepare(
    `UPDATE message_events SET created_at = ? WHERE created_at < ? AND message_id IN
       (SELECT id FROM messages WHERE stream_session_id = ? OR stream_session_id LIKE ? || '#%')`,
  ).run(ts + 50, ts + 50, ssi, ssi);
  __routeChunkToBufferForTest({ type: 'end', streamSessionId: ssi, finishReason: 'stop' });
  __flushEventBufferForTest();
}

/** owner 行 + 显式时序（字段照抄 session-service.sendUserMessage） */
function seedOwnerRow(body: string, ts: number): void {
  const row = insertMessage({ sessionId: ROOM, sender: 'owner', eventType: 'm.room.message', body });
  getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(ts, row.id);
}

/** 旧 stub bigHistory 的 DB 等价物：prior 摘要头 + BIG 文本族（head 非空可压） */
function seedBigHistory(): void {
  seedSessionRow();
  const T0 = Date.now();
  getDb().prepare(
    `INSERT INTO session_compactions (session_id, summary, covered_until, updated_at)
     VALUES (?, '旧摘要正文-PRIOR', ?, ?)`,
  ).run(ROOM, T0 + 100, T0 + 100);
  seedTextFamily('s-big-1', BIG, T0 + 200);
}

/** (g) 专用：BIG 族 → 真实 user → BIG 族 → 当前指令行（生产时序：先落库后派发） */
function seedAnchorSkipHistory(): void {
  const T0 = Date.now();
  seedTextFamily('s-g-1', BIG, T0 + 100);
  seedOwnerRow('真实请求-分析报告', T0 + 200);
  seedTextFamily('s-g-2', BIG, T0 + 300);
  seedOwnerRow('[历史压缩摘要]\n上一轮的摘要文本', T0 + 400);
}

describe('auto 阈值自动压缩（spec §6.2）', () => {
  const originalSend = process.send;

  const stubProvider: MemoryProvider = {
    getTaskContext: async () => null,
    // B 段后顶层路径不再消费（rebuildSessionContext 接管），保留空返回防契约回退
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
    script = [];
    __setTodosForTest(SID, []);
    vi.mocked(createLLMProvider).mockReset();
    installScriptedProvider();
    requestCompactionMock.mockReset();
    requestCompactionMock.mockResolvedValue(MOCK_SUMMARY);
    __setMemoryProviderForTest(stubProvider);
    process.send = ((_msg: unknown): boolean => true) as NonNullable<typeof process.send>;
    // B 段新契约：真实 DB（rebuildSessionContext 的数据源），每用例全新库
    fs.mkdirSync(tmpRoot, { recursive: true });
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
    __resetEventBufferForTest();
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
    __resetEventBufferForTest();
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('(a) 超阈值触发：IPC 收到 head 序列化，压缩后含摘要条且尾部 verbatim 保留', async () => {
    seedBigHistory();
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
    seedBigHistory();
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
    seedBigHistory();
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
    seedBigHistory();
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
    seedBigHistory();
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

  it('(f) 尾部选择工具对原子性：预算切点不得制造孤儿 tool 消息（审查 Critical）', async () => {
    // 构造（孤儿形态要求 pair 位于锚点之前——锚点后的消息受锚点保护必入尾部）：
    // 第 1 轮 LLM 调 big_tool（大参数挂在 assistant 消息上 ≈7500 tok）→ tool 结果
    // 1000 tok 入尾部；done 后注入 steer → 第 2 轮顶部 drain push 为末尾真实
    // user 消息（锚点）。auto 压缩时预算累计恰好在 assistant 与其 tool 结果之间
    // 夹住——无修复则 assistant 进 head、其 tool 结果成为尾部第一条
    // （孤儿 tool 消息 → OpenAI/Anthropic 请求体硬性 400）。
    script = [
      { toolCall: { name: 'big_tool', arguments: { payload: BIG_TOOL_ARGS } }, emitSteer: '继续推进数据分析' },
      { text: '收到，继续。' },
    ];
    await runChatLoop(
      ROOM, '请处理大数据任务', mkConfig({ contextWindow: 1000 }),
      mkCtx({ toolModules: [bigToolModule] }),
      undefined, undefined, undefined, SID,
    );
    expect(requestCompactionMock).toHaveBeenCalledTimes(1);
    // 核心断言：压缩后发给 LLM 的 messages 无孤儿 tool（toolCallId 必须在其前方
    // assistant.toolCalls 中出现）
    assertNoOrphanToolMessages(captured[1]!.messages);
    // 工具对整体保留在尾部（assistant 与其结果 verbatim），头部进摘要
    const round2 = JSON.stringify(captured[1]!.messages);
    expect(round2).toContain(BIG_TOOL_RESULT);
    expect(round2).toContain('[历史压缩摘要]');
    // head 序列化收到锚点之前的当前轮首条 user 消息
    const conversation = requestCompactionMock.mock.calls[0] as unknown as [string, string, number];
    expect(conversation[1]).toContain('请处理大数据任务');
  });

  it('(g) 锚点跳过末尾合成条：落在真实 user 消息（审查 Minor-3 专项锁）', async () => {
    // 二次压缩形态：当前轮 user 消息本身是合成摘要条（上一轮压缩产物），其前
    // 才是真实 user 消息——锚点必须跳过合成条落在真实消息上，否则真实消息被
    // 划入可压缩区（切断 mandate 所在轮）。history 前置一条 >KEEP 大消息使
    // head 非空（真实消息与大消息之间的边界即压缩切点）。
    seedAnchorSkipHistory();
    script = [{ text: '已总结。' }];
    await runChatLoop(
      ROOM, '[历史压缩摘要]\n上一轮的摘要文本', mkConfig({ contextWindow: 1000 }), mkCtx(),
      undefined, undefined, undefined, SID,
    );
    expect(requestCompactionMock).toHaveBeenCalledTimes(1);
    // 锚点跳过证明：真实 user 消息与其后大消息 verbatim 保留在尾部
    const round1 = JSON.stringify(captured[0]!.messages);
    expect(round1).toContain('真实请求-分析报告');
    expect(round1).toContain(BIG);
    expect(round1).toContain('[历史压缩摘要]');
    // 若锚点误落在合成条上：真实消息会进 head 被摘要——此处 head 只有序列化
    // 的首轮大消息（锚点正确时的预期），不含真实消息
    const conversation = requestCompactionMock.mock.calls[0] as unknown as [string, string, number];
    expect(conversation[1]).not.toContain('真实请求-分析报告');
    expect(conversation[1]).toContain(BIG);
  });
});
