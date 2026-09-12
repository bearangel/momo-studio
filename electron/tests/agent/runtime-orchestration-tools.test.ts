// electron/tests/agent/runtime-orchestration-tools.test.ts
//
// v2.8.0 Orchestration T7：5 工具面 + 注入 + 路由回归锁
// （spec 2026-09-12 orchestration-primitives §5/§6/§9）。
//
// 驱动方式（momo-test-rules 保真度）：
//   - dispatch-wait 只在「执行体边界」替换为 spy（executeDispatch / executeDispatchBg /
//     executeFollowup / executeGather / executeStatus / executeCancel）——执行体自身
//     行为已由 dispatch-bg.test.ts / dispatch-followup.test.ts / dispatch-wait.test.ts
//     用真实实现锁定；本文件锁「接线」：工具名 → 执行体 + 实参形态 + chip 契约。
//     getSessionDispatchScope 等其余导出保持真实实现（importOriginal 展开）。
//   - 注入面 / isDispatch 防御经真实 runChatLoop 驱动（mock 只落 LLM 边界 +
//     process.send 拦截，同 dispatch-parallel.test.ts 形态；会话边界走真实 DB seed）。
//
// 核心断言：
//   1. 注入面：leader 会话 LLM 首轮可见 5 类工具（4 静态 + dispatch_bg:<slug>×成员数）；
//      单成员会话（非 leader 域）5 类零注入
//   2. 路由透传：每工具名 → 对应执行体被调（followup 的 signal / bg 的预生成
//      subStreamSessionId 非空 / gather 的 handles+mode / status+cancel 的 handle）
//   3. isDispatch 防御：dispatch_bg: 不被 dispatch-parallel 批处理拦截（走普通路径），
//      同 callId 仅一个 tool_call chip（路由层 isDispatch 形态，无双重渲染）
//   4. 白名单同步：带 allowedTools 的 leader 可调编排工具（不被 permission 拒绝）
//   5. dispatchHint 教学段：bg→gather 工作流 / followup 续接 / 超时非错误语义

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import type { LLMMessage, StreamDelta } from '../../src/main/agent/llm-provider';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';

// 必须在 import runtime-entry 之前 mock（vi.mock 会被 hoist）。
// llm-provider：chatStream 预置轮次（与 dispatch-parallel.test.ts 同款）。
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

// dispatch-wait：执行体边界 spy（真实语义已在专项测试文件锁定，见文件头注释）。
vi.mock('../../src/main/agent/dispatch-wait', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/dispatch-wait')>();
  return {
    ...actual,
    executeDispatch: vi.fn(async () => ({ body: '同步结果', toolCallsUsed: 1 })),
    executeDispatchBg: vi.fn(async () => ({ taskId: 'bg-task-1' })),
    executeFollowup: vi.fn(async () => ({ body: '续答正文', toolCallsUsed: 0 })),
    executeGather: vi.fn(async () => ({ done: [], pending: [], notes: [] })),
    executeStatus: vi.fn(() => ({ status: 'in_flight', elapsedMs: 5 })),
    executeCancel: vi.fn(() => ({ status: 'cancelled' })),
  };
});

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import {
  doExecuteTool,
  runChatLoop,
  type RuntimeContext,
} from '../../src/main/agent/runtime-entry';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import {
  executeDispatch,
  executeDispatchBg,
  executeFollowup,
  executeGather,
  executeStatus,
  executeCancel,
} from '../../src/main/agent/dispatch-wait';
import { getOrchestrationToolDefs } from '../../src/main/agent/builtin-tools';
import { formatDispatchHint } from '../../src/main/agent/prompt-hints';
import { buildToolRegistry } from '../../src/main/agent/tools';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

// === 公共构造（与 dispatch-parallel.test.ts 同款形态） ===

/** MemoryProvider stub：空对话 + 无 task（不落库） */
const stubMemoryProvider: MemoryProvider = {
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

const sentChunks: unknown[] = [];

/** 构造 LLMToolCall */
function call(name: string, args: Record<string, unknown>): {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
} {
  return { id: 'call-x', name, arguments: args };
}

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

/** 多成员会话 leader + 两个子 agent（researcher / writer）——编排工具注入前提 */
function makeMainConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return makeConfig({
    isLeader: true,
    subAgents: [
      { slug: 'researcher', assignmentId: 'inst-researcher', description: '研究员' },
      { slug: 'writer', assignmentId: 'inst-writer', description: '撰稿人' },
    ],
    ...overrides,
  });
}

/** doExecuteTool 路由测试用 ctx（bg 分支 chip 走模块级 sendStreamChunk → process.send） */
function makeRoutingCtx(abortSignal?: AbortSignal): RuntimeContext {
  const mockWsFs = {} as unknown as WorkspaceFS; // 编排分支不触文件系统
  return {
    wsFs: mockWsFs,
    skillRegistry: { list: () => [] } as unknown as RuntimeContext['skillRegistry'],
    tools: [],
    systemPrompt: '',
    workspaceId: 'ws-1',
    workspaceDir: '/tmp/test',
    creatorUserId: '@owner:test',
    roomId: 'sess-exec',
    streamSessionId: 'ss-pm',
    sendStreamChunk: () => {},
    toolModules: [],
    ...(abortSignal ? { abortSignal } : {}),
  };
}

/** runChatLoop 测试用 ctx（与 dispatch-parallel.test.ts makeContext 同款） */
function makeLoopContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  const mockWsFs = {
    readFile: vi.fn().mockResolvedValue(Buffer.from('mock file content')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    listDir: vi.fn().mockResolvedValue([]),
    assertInWorkspace: (p: string) => path.resolve('/tmp/test', p),
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
      permissionConfig: { allowedTools: [] as string[], deniedTools: [] as string[] },
    }),
    ...overrides,
  };
}

/** mock chatStream——每次调用返回下一个预置 delta 序列 */
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

/** 读取 chatStream 各轮调用参数（messages / tools） */
function chatStreamCalls(): Array<{ messages: LLMMessage[]; tools?: unknown }> {
  const provider = vi.mocked(createLLMProvider).mock.results[0]!.value as {
    chatStream: ReturnType<typeof vi.fn>;
  };
  return provider.chatStream.mock.calls.map((c) => ({
    messages: c[0] as LLMMessage[],
    tools: c[1] as unknown,
  }));
}

function clearExecutorMocks(): void {
  vi.mocked(executeDispatch).mockClear();
  vi.mocked(executeDispatchBg).mockClear();
  vi.mocked(executeFollowup).mockClear();
  vi.mocked(executeGather).mockClear();
  vi.mocked(executeStatus).mockClear();
  vi.mocked(executeCancel).mockClear();
}

// === Part 1：doExecuteTool 编排工具路由（执行体接线 + 实参形态） ===

describe('doExecuteTool 编排工具路由（5 执行体接线）', () => {
  const originalSend = process.send;

  beforeEach(() => {
    sentChunks.length = 0;
    clearExecutorMocks();
    // bg 分支 chip 走模块级 sendStreamChunk → process.send（照 execDispatchCall
    // 形态）——经进程边界捕获（momo-test-rules：mock 只落进程/网络边界）
    process.send = ((msg: unknown): boolean => {
      sentChunks.push(msg);
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
  });

  it('dispatch_followup → executeFollowup(taskId, question, config, executionSessionId, signal, pmStreamSessionId)，返回 body', async () => {
    const controller = new AbortController();
    const config = makeMainConfig();
    const out = await doExecuteTool(
      call('dispatch_followup', { taskId: 'T-1', question: '展开结论' }),
      makeRoutingCtx(controller.signal),
      config,
      undefined,
      undefined,
      undefined,
      'ss-pm',
      'sess-exec',
    );
    expect(out).toBe('续答正文');
    expect(executeFollowup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeFollowup).mock.calls[0]!.slice(0, 6)).toEqual([
      'T-1',
      '展开结论',
      config,
      'sess-exec',
      controller.signal,
      'ss-pm',
    ]);
  });

  it('dispatch_bg:<slug> → executeDispatchBg + 预生成 subStreamSessionId 非空 + isDispatch chip 照 execDispatchCall 形态', async () => {
    const config = makeMainConfig();
    const out = await doExecuteTool(
      { id: 'cb-1', name: 'dispatch_bg:researcher', arguments: { task: '后台任务', toolBudget: 3 } },
      makeRoutingCtx(),
      config,
      undefined,
      undefined,
      undefined,
      'ss-pm',
      'sess-exec',
    );
    expect(out).toBe(JSON.stringify({ taskId: 'bg-task-1' }));
    expect(executeDispatchBg).toHaveBeenCalledTimes(1);
    const args = vi.mocked(executeDispatchBg).mock.calls[0]!;
    expect(args[0]).toBe('researcher');
    expect(args[1]).toBe('后台任务');
    expect(args[2]).toBe(config);
    expect(args[3]).toBe(3);
    // T4 硬性：subStreamSessionId 预生成非空（句柄存它——dispatch_cancel 级联依赖）
    expect(typeof args[4]).toBe('string');
    expect((args[4] as string).length).toBeGreaterThan(0);
    expect(args[5]).toBe('ss-pm');
    expect(args[6]).toBe('sess-exec');
    // chip：与 execDispatchCall 同形（isDispatch + subStreamSessionId + 子 agent 展示名）
    const chips = sentChunks.filter(
      (c) => (c as { type?: string }).type === 'tool_call',
    ) as Extract<StreamChunk, { type: 'tool_call' }>[];
    expect(chips).toHaveLength(1);
    expect(chips[0]!.isDispatch).toBe(true);
    expect(chips[0]!.subStreamSessionId).toBe(args[4]);
    expect(chips[0]!.subAgentName).toBe('研究员');
    expect(chips[0]!.subAgentAvatar).toBe('🤖');
    expect(chips[0]!.callId).toBe('cb-1');
    expect(chips[0]!.toolName).toBe('dispatch_bg:researcher');
    expect(chips[0]!.streamSessionId).toBe('ss-pm');
  });

  it('dispatch_gather → executeGather(handles, mode, timeoutMs, ctx.abortSignal) 透传（终审 I1 接线锁）', async () => {
    const controller = new AbortController();
    const out = await doExecuteTool(
      call('dispatch_gather', { handles: ['h1', 'h2'], mode: 'any', timeoutMs: 5000 }),
      makeRoutingCtx(controller.signal),
      makeMainConfig(),
      undefined,
      undefined,
      undefined,
      'ss-pm',
      'sess-exec',
    );
    expect(out).toBe(JSON.stringify({ done: [], pending: [], notes: [] }));
    // 第 4 参 = ctx.abortSignal——摘掉接线（漏传 signal）此断言即红
    expect(executeGather).toHaveBeenCalledWith(['h1', 'h2'], 'any', 5000, controller.signal);
  });

  it('dispatch_status → executeStatus(handle) 透传', async () => {
    const out = await doExecuteTool(
      call('dispatch_status', { handle: 'h1' }),
      makeRoutingCtx(),
      makeMainConfig(),
      undefined,
      undefined,
      undefined,
      'ss-pm',
      'sess-exec',
    );
    expect(out).toBe(JSON.stringify({ status: 'in_flight', elapsedMs: 5 }));
    expect(executeStatus).toHaveBeenCalledWith('h1');
  });

  it('dispatch_cancel → executeCancel(handle, config, executionSessionId) 透传', async () => {
    const config = makeMainConfig();
    const out = await doExecuteTool(
      call('dispatch_cancel', { handle: 'h1' }),
      makeRoutingCtx(),
      config,
      undefined,
      undefined,
      undefined,
      'ss-pm',
      'sess-exec',
    );
    expect(out).toBe(JSON.stringify({ status: 'cancelled' }));
    expect(executeCancel).toHaveBeenCalledWith('h1', config, 'sess-exec');
  });

  // === 错误路径（momo-test-rules：错误路径与空输入专项） ===

  it('dispatch_followup 缺 taskId → 明确报错', async () => {
    await expect(
      doExecuteTool(
        call('dispatch_followup', { question: 'q' }),
        makeRoutingCtx(),
        makeMainConfig(),
      ),
    ).rejects.toThrow('taskId');
    expect(executeFollowup).not.toHaveBeenCalled();
  });

  it('dispatch_gather handles 非数组 → 明确报错', async () => {
    await expect(
      doExecuteTool(
        call('dispatch_gather', { handles: 'h1', mode: 'all' }),
        makeRoutingCtx(),
        makeMainConfig(),
      ),
    ).rejects.toThrow('handles');
    expect(executeGather).not.toHaveBeenCalled();
  });

  it('dispatch_gather mode 非法枚举 → 明确报错', async () => {
    await expect(
      doExecuteTool(
        call('dispatch_gather', { handles: ['h1'], mode: 'some' }),
        makeRoutingCtx(),
        makeMainConfig(),
      ),
    ).rejects.toThrow('mode');
    expect(executeGather).not.toHaveBeenCalled();
  });

  it('dispatch_status 缺 handle → 明确报错', async () => {
    await expect(
      doExecuteTool(call('dispatch_status', {}), makeRoutingCtx(), makeMainConfig()),
    ).rejects.toThrow('handle');
    expect(executeStatus).not.toHaveBeenCalled();
  });
});

// === Part 2：工具面 defs + hint 教学段（纯函数单元） ===

describe('getOrchestrationToolDefs 工具面（spec §5）', () => {
  const subs = [
    { slug: 'researcher', assignmentId: 'inst-r', description: '研究员' },
    { slug: 'writer', assignmentId: 'inst-w', description: '撰稿人' },
  ];

  it('4 静态名 + dispatch_bg:<slug> 随成员数动态生成', () => {
    const names = getOrchestrationToolDefs(subs).map((d) => d.name);
    for (const n of ['dispatch_followup', 'dispatch_gather', 'dispatch_status', 'dispatch_cancel']) {
      expect(names).toContain(n);
    }
    expect(names.filter((n) => n.startsWith('dispatch_bg:'))).toEqual([
      'dispatch_bg:researcher',
      'dispatch_bg:writer',
    ]);
  });

  it('schema 形状：followup {taskId, question} 必填 / bg {task 必填, toolBudget 可选} / gather {handles, mode enum, timeoutMs}', () => {
    const byName = new Map(getOrchestrationToolDefs(subs).map((d) => [d.name, d]));
    const fu = byName.get('dispatch_followup')!;
    const fuSchema = fu.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(fuSchema.properties).sort()).toEqual(['question', 'taskId']);
    expect(fuSchema.required).toEqual(['taskId', 'question']);

    const bg = byName.get('dispatch_bg:researcher')!;
    const bgSchema = bg.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(bgSchema.properties).sort()).toEqual(['task', 'toolBudget']);
    expect(bgSchema.required).toEqual(['task']);

    const ga = byName.get('dispatch_gather')!;
    const gaSchema = ga.inputSchema as {
      properties: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(gaSchema.properties.mode?.enum).toEqual(['all', 'any']);
    expect(gaSchema.required).toEqual(['handles', 'mode']);

    const st = byName.get('dispatch_status')!;
    expect(((st.inputSchema as { required?: string[] }).required)).toEqual(['handle']);
  });

  it('描述含使用模式教学（bg 先派→gather 收 / 超时非错误 / cancel 止损 / followup 仅用 dispatch 返回的 taskId）', () => {
    const text = getOrchestrationToolDefs(subs)
      .map((d) => d.description)
      .join('\n');
    expect(text).toContain('gather');
    expect(text).toContain('超时');
    expect(text).toContain('dispatch 返回的 taskId');
  });
});

describe('formatDispatchHint 编排教学段', () => {
  it('leader → 含 bg→gather 工作流 / followup 续接 / 超时语义', () => {
    const hint = formatDispatchHint(makeMainConfig());
    expect(hint).toContain('dispatch_bg');
    expect(hint).toContain('dispatch_gather');
    expect(hint).toContain('dispatch_followup');
    expect(hint).toContain('dispatch_cancel');
    expect(hint).toContain('超时');
  });

  it('非 leader → 空串（编排教学不注入普通 agent）', () => {
    expect(formatDispatchHint(makeConfig())).toBe('');
  });
});

// === Part 3：runChatLoop 注入面 + isDispatch 防御（真实会话边界 DB seed） ===

describe('runChatLoop 注入面 + isDispatch 防御', () => {
  const originalSend = process.send;
  /** seed 会话的真实 id（runChatLoop 以它为 roomId = executionSessionId） */
  let leaderSessId = '';
  let soloSessId = '';

  beforeEach(() => {
    sentChunks.length = 0;
    clearExecutorMocks();
    vi.mocked(createLLMProvider).mockReset();
    __setMemoryProviderForTest(stubMemoryProvider);
    // 会话边界判定（getSessionDispatchScope）需真实 session_members 行：
    // seed ws + agent 链 + leader 双成员会话 + 单成员会话（非 leader 域）
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-orch-tools-'));
    process.env.AP_USER_DATA_DIR = tmp;
    runMigrations();
    const db = getDb();
    db.prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`,
    ).run();
    for (const inst of ['inst-bot', 'inst-researcher', 'inst-writer']) {
      db.prepare(
        `INSERT INTO agent_definitions
           (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
            default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
         VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
      ).run(inst, inst, inst);
      db.prepare(
        `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
         VALUES (?, 'ws', ?, ?)`,
      ).run(inst, inst, `agent-${inst}`);
    }
    const leader = insertSession({ workspaceId: 'ws', title: 'orch-leader' });
    addSessionMember(leader.id, 'inst-bot', true);
    addSessionMember(leader.id, 'inst-researcher', false);
    addSessionMember(leader.id, 'inst-writer', false);
    leaderSessId = leader.id;
    const solo = insertSession({ workspaceId: 'ws', title: 'orch-solo' });
    addSessionMember(solo.id, 'inst-bot', true);
    soloSessId = solo.id;

    process.send = ((msg: unknown): boolean => {
      sentChunks.push(msg);
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
    closeDb();
    fs.rmSync(process.env.AP_USER_DATA_DIR ?? '', { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('leader 会话 → LLM 首轮可见 5 类编排工具（4 静态 + dispatch_bg×2）+ system prompt 含教学关键模式词', async () => {
    mockProviderMultiRound([[{ type: 'text', content: 'ok' }, { type: 'done', finishReason: 'stop' }]]);
    await runChatLoop(leaderSessId, '查', makeMainConfig(), makeLoopContext());

    const names = (chatStreamCalls()[0]!.tools as Array<{ name: string }>).map((t) => t.name);
    for (const n of ['dispatch_followup', 'dispatch_gather', 'dispatch_status', 'dispatch_cancel']) {
      expect(names).toContain(n);
    }
    expect(names.filter((n) => n.startsWith('dispatch_bg:'))).toEqual([
      'dispatch_bg:researcher',
      'dispatch_bg:writer',
    ]);
    // 既有 dispatch:<slug> 同门注入不受影响
    expect(names).toContain('dispatch:researcher');
    expect(names).toContain('dispatch:writer');
    // system prompt 教学段（staticSystem 含 dispatchHint）
    const sys = chatStreamCalls()[0]!.messages[0]!.content;
    expect(sys).toContain('dispatch_gather');
    expect(sys).toContain('超时');
    expect(sys).toContain('dispatch_followup');
  });

  it('单成员会话（非 leader 域）→ 5 类编排工具零注入', async () => {
    mockProviderMultiRound([[{ type: 'text', content: 'ok' }, { type: 'done', finishReason: 'stop' }]]);
    await runChatLoop(soloSessId, '查', makeMainConfig(), makeLoopContext());

    const names = (chatStreamCalls()[0]!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names.some((n) => n.startsWith('dispatch_bg:'))).toBe(false);
    expect(names.some((n) => n.startsWith('dispatch:'))).toBe(false);
    for (const n of ['dispatch_followup', 'dispatch_gather', 'dispatch_status', 'dispatch_cancel']) {
      expect(names).not.toContain(n);
    }
  });

  it('subAgents∩会话成员=空（sessionSubs=[]）→ 编排工具零注入 + 教学段不出现（注入门统一 length 判定，T7 Minor）', async () => {
    // 场景：多成员会话且自己是 leader，但 subAgents 快照成员无一在会话内——
    // getSessionDispatchScope 走 filter 空交集返回 [] 而非 null。
    // 修复前：hint 门判 length（isLeader=false → 无教学段）而工具门判 truthy
    // （[] 为真 → 4 个静态编排工具照注入）——「无 hint 有工具」门不一致。
    const db = getDb();
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
          default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES ('inst-outsider', 'inst-outsider', 'inst-outsider', '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES ('inst-outsider', 'ws', 'inst-outsider', 'agent-inst-outsider')`,
    ).run();
    const disjoint = insertSession({ workspaceId: 'ws', title: 'orch-disjoint' });
    addSessionMember(disjoint.id, 'inst-bot', true);
    addSessionMember(disjoint.id, 'inst-outsider', false);

    mockProviderMultiRound([[{ type: 'text', content: 'ok' }, { type: 'done', finishReason: 'stop' }]]);
    await runChatLoop(disjoint.id, '查', makeMainConfig(), makeLoopContext());

    const first = chatStreamCalls()[0]!;
    const names = (first.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names.some((n) => n.startsWith('dispatch_bg:'))).toBe(false);
    expect(names.some((n) => n.startsWith('dispatch:'))).toBe(false);
    for (const n of ['dispatch_followup', 'dispatch_gather', 'dispatch_status', 'dispatch_cancel']) {
      expect(names).not.toContain(n);
    }
    // 门一致性另一半：isLeader=false → dispatchHint 空串（system 无教学段）
    expect(first.messages[0]!.content).not.toContain('dispatch_gather');
  });

  it('isDispatch 防御：dispatch_bg 不被并行批处理拦截——走普通路径 + 同 callId 单 chip（无双重渲染）', async () => {
    const cBg = { id: 'cBg', name: 'dispatch_bg:researcher', arguments: { task: '后台' } };
    const cD = { id: 'cD', name: 'dispatch:writer', arguments: { task: '同步' } };
    mockProviderMultiRound([
      [
        { type: 'tool_use', toolCall: cBg },
        { type: 'tool_use', toolCall: cD },
        { type: 'done', finishReason: 'tool_use' },
      ],
      [{ type: 'text', content: '完成' }, { type: 'done', finishReason: 'stop' }],
    ]);
    await runChatLoop(leaderSessId, '混合', makeMainConfig(), makeLoopContext());

    // 命名防御锁：dispatch_bg: 前缀不命中 dispatch: 批处理判定（spec §6）
    expect('dispatch_bg:coder'.startsWith('dispatch:')).toBe(false);
    // bg 走 doExecuteTool 普通路径：executeDispatchBg 收到干净 slug（若被批处理
    // 拦截，会以 'bg:researcher' 为 slug 调 executeDispatch 且 bg 执行体零调用）
    expect(executeDispatchBg).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeDispatchBg).mock.calls[0]![0]).toBe('researcher');
    // 同轮 dispatch: 成员仍走批处理（既有语义不破）
    expect(executeDispatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeDispatch).mock.calls[0]![0]).toBe('writer');
    // 单 chip：bg 的 tool_call 仅一个（普通路径 plain chip 被跳过，仅路由层
    // isDispatch chip）——双 chip 会在 renderer 聚合出双段渲染
    const bgChips = sentChunks.filter(
      (c) =>
        (c as { type?: string }).type === 'tool_call' && (c as { callId?: string }).callId === 'cBg',
    );
    expect(bgChips).toHaveLength(1);
    expect((bgChips[0] as { isDispatch?: boolean }).isDispatch).toBe(true);
    expect(typeof (bgChips[0] as { subStreamSessionId?: string }).subStreamSessionId).toBe('string');
    // 协议配对：bg 的 tool_result 存在（成功，结果含 taskId 句柄）
    const bgResults = sentChunks.filter(
      (c) =>
        (c as { type?: string }).type === 'tool_result' &&
        (c as { callId?: string }).callId === 'cBg',
    );
    expect(bgResults).toHaveLength(1);
    expect((bgResults[0] as { result?: string }).result).toContain('bg-task-1');
    expect((bgResults[0] as { success?: boolean }).success).toBe(true);
  });

  it('allowedTools 白名单同步——带白名单的 leader 可调编排工具（不被 permission 拒绝）', async () => {
    const cS = { id: 'cS', name: 'dispatch_status', arguments: { handle: 'h1' } };
    mockProviderMultiRound([
      [
        { type: 'tool_use', toolCall: cS },
        { type: 'done', finishReason: 'tool_use' },
      ],
      [{ type: 'text', content: '完成' }, { type: 'done', finishReason: 'stop' }],
    ]);
    await runChatLoop(
      leaderSessId,
      '查状态',
      makeMainConfig({ allowedTools: ['read_file'] }),
      makeLoopContext(),
    );

    // 未同步白名单时 assertToolAllowed 会先抛「不在允许列表中」，执行体零调用
    expect(executeStatus).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeStatus).mock.calls[0]![0]).toBe('h1');
  });
});
