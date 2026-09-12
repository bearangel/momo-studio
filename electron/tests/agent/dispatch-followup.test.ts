// electron/tests/agent/dispatch-followup.test.ts
//
// v2.8.0 Orchestration 元语 Task 6：dispatch_followup 执行体（spec §3）。
// 锁定语义：
//   1. 校验三连：
//      a. 链存在——messages 表 (task_id, session_id) 双键有行；无行（含会话
//         不匹配 / executionSessionId 缺失）→ 统一文案「仅可追问自己此前
//         dispatch 的任务」（不区分不存在/非自己以省探测——所有权=会话边界）
//      b. 同链无在途——pendingReplies 或 bgHandles(in_flight) 有该 taskId →
//         「上一轮仍在进行中」拒绝；bg done / 已 settle 不阻塞
//      c. 会话边界——链首子消息 sender（agentUserId）反查 assignment →
//         assertSessionDispatchAllowed 既有跨会话/单成员拒绝
//   2. 成功路径：重建前缀 → 追问 user 行落库（原文，无降级提示）→ 派发
//      content 沿用原 taskId + 新 subStreamSessionId + history_prefix +
//      body=question → pendingReplies 注册 → reply resolve
//   3. degraded：重建降级 → history_prefix 字段缺席 + body 前缀追加
//      「（此前对话历史不可用）」提示；落库行仍是原文
//   4. abort signal：onAbort 清理 pendingReplies + reject(AbortError) +
//      发 abort_dispatch（携带新 subStreamSessionId）
//   5. 接线锁（boundary-rules 铁律 4——生产者/消费者成对）：
//      - routeDispatch：content.history_prefix → TaskConfig.historyPrefix
//        （非法载荷丢弃字段不拒整条；taskId === dispatchContext.task_id 同值双设）
//      - AgentRunner.executeTask：historyPrefix 透传 task-config（未携带时
//        载荷无该字段——wire 零变化）
//
// fixture 保真度（momo-test-rules）：真实 SQLite（tmp + AP_USER_DATA_DIR +
// runMigrations）；链首轮行经 stream-relay 生产落库链（start 带 taskId →
// text → end → flush，同 dispatch-chain-tagging.test.ts 模式）；mock 只落在
// process.send 进程边界 + electron BrowserWindow（stream-relay 推送降级）；
// pendingReplies / 句柄表 / handleTaskReply / 重建器全部走真实实现。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';

// mock electron：stream-relay 的 BrowserWindow 推送在测试环境静默降级
//（同 dispatch-chain-tagging.test.ts 模式）
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { insertMessage, listMessagesBySession } from '../../src/main/storage/messages/repo';
import {
  executeFollowup,
  handleTaskReply,
  __seedBgHandleForTest,
  __resetBgStateForTest,
} from '../../src/main/agent/dispatch-wait';
import {
  __routeChunkToBufferForTest,
  __resetEventBufferForTest,
  __flushEventBufferForTest,
} from '../../src/main/agent/stream-relay';
import { RouterService } from '../../src/main/agent/router-service';
import type { AgentRunner } from '../../src/main/agent/agent-runner';
import { AgentRunner as AgentRunnerCtor } from '../../src/main/agent/agent-runner';
import { WarmPool } from '../../src/main/agent/warm-pool';
import { INTERNAL_EVENT_MSG, type InternalEventMsg } from '../../src/main/agent/internal-event';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import type { LLMMessage } from '../../src/main/agent/llm-provider';

// === DB / 进程边界夹具（dispatch-bg.test.ts 同款） ===

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-dispatch-followup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const sentEvents: InternalEventMsg[] = [];
const originalSend = process.send;
/** beforeEach seed 的会话 id（insertSession 自生成 uuid，测试体经此引用） */
let sessChatId = '';

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-pm',
    agentUserId: 'agent-pm-01',
    systemPrompt: 'x',
    modelName: 'm',
    llmApiKey: 'k',
    workspaceDir: '/tmp',
    workspaceId: 'ws',
    role: 'main',
    subAgents: [{ slug: 'ui', assignmentId: 'inst-sub', description: 'UI' }],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: false,
    devMode: false,
    maxToolCalls: -1,
    contextWindow: 0,
    outputTokens: 0,
    ...overrides,
  };
}

/** seed agent 定义 + workspace 成员行（workspace_agent_members.agent_user_id = `agent-<inst>`） */
function seedAgentInstance(instanceId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
        default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
     VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
  ).run(instanceId, instanceId, instanceId);
  db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES (?, 'ws', ?, ?)`,
  ).run(instanceId, instanceId, `agent-${instanceId}`);
}

/**
 * 经 stream-relay 生产链 seed 链首轮：子 agent 流行（start 带 taskId 打标 →
 * text → end → flush），行 sender = inst-sub 的 agentUserId。落库后链存在
 * （校验 a）+ 重建器可聚合出 assistant 首轮结论（事件随行写入）。
 */
function seedFirstRound(taskId: string): void {
  __routeChunkToBufferForTest({
    type: 'start',
    streamSessionId: 'ss-r1',
    sessionId: sessChatId,
    senderAgentId: 'agent-inst-sub',
    taskId,
  });
  __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-r1', delta: '首轮结论' });
  __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-r1', finishReason: 'stop' });
  __flushEventBufferForTest();
}

/** 该链已落库的 followup 追问 user 行 */
function followupRows(taskId: string): Array<{ body: string; parentStreamSessionId: string | null }> {
  return listMessagesBySession(sessChatId)
    .filter((r) => r.taskId === taskId && r.sender === 'owner')
    .map((r) => ({ body: r.body, parentStreamSessionId: r.parentStreamSessionId }));
}

function dispatchContents(): Array<Record<string, unknown>> {
  return sentEvents
    .filter((e) => e.eventType === 'io.momo-studio.dispatch')
    .map((e) => e.content);
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`).run();
  // inst-other：边界用例中删除 inst-sub 成员后保住「多成员会话」前提，
  // 使错误落在「目标不是会话成员」而非「单成员会话」
  for (const inst of ['inst-pm', 'inst-sub', 'inst-other']) seedAgentInstance(inst);
  const sess = insertSession({ workspaceId: 'ws', title: 'followup' });
  addSessionMember(sess.id, 'inst-pm', true);
  addSessionMember(sess.id, 'inst-sub', false);
  addSessionMember(sess.id, 'inst-other', false);
  sessChatId = sess.id;

  __resetBgStateForTest();
  __resetEventBufferForTest();
  sentEvents.length = 0;
  process.send = ((msg: unknown): boolean => {
    const m = msg as InternalEventMsg;
    if (m?.type === INTERNAL_EVENT_MSG) sentEvents.push(m);
    return true;
  }) as NonNullable<typeof process.send>;
});

afterEach(() => {
  process.send = originalSend;
  __resetBgStateForTest();
  __resetEventBufferForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// ══════════════════════════════════════════════════════════════════════════
// 1. 校验三连
// ══════════════════════════════════════════════════════════════════════════

describe('executeFollowup 校验三连', () => {
  it('链不存在（未知 taskId）→ 统一文案拒绝，不落库不发事件', async () => {
    await expect(
      executeFollowup('T-chain-ghost', '追问', makeConfig(), sessChatId),
    ).rejects.toThrow('仅可追问自己此前 dispatch 的任务');

    expect(dispatchContents()).toHaveLength(0);
    expect(followupRows('T-chain-ghost')).toHaveLength(0);
  });

  it('链存在但在别的会话（session_id 过滤）→ 同样按链不存在拒绝（所有权=会话边界）', async () => {
    const CHAIN = 'T-chain-x-session';
    seedFirstRound(CHAIN);
    // 同 taskId 的行存在，但用另一会话 id 追问 → 双键查询无行
    await expect(
      executeFollowup(CHAIN, '追问', makeConfig(), 'sess-别的会话'),
    ).rejects.toThrow('仅可追问自己此前 dispatch 的任务');
    expect(dispatchContents()).toHaveLength(0);
  });

  it('executionSessionId 缺失 → 无法定位链，按链不存在拒绝', async () => {
    await expect(
      executeFollowup('T-any', '追问', makeConfig(), undefined),
    ).rejects.toThrow('仅可追问自己此前 dispatch 的任务');
  });

  it('同链 pendingReplies 在途 → 「上一轮仍在进行中」拒绝；不重复落库；settle 后放行', async () => {
    const CHAIN = 'T-chain-inflight';
    seedFirstRound(CHAIN);
    const cfg = makeConfig();

    const p1 = executeFollowup(CHAIN, '第一问', cfg, sessChatId, undefined, 'ss-pm-a', 'ss-r2a');
    await expect(
      executeFollowup(CHAIN, '第二问', cfg, sessChatId),
    ).rejects.toThrow('上一轮仍在进行中');
    // 拒绝路径不落追问行（仍只有第一问）
    expect(followupRows(CHAIN)).toHaveLength(1);
    expect(followupRows(CHAIN)[0]?.body).toBe('第一问');

    // settle 第一轮后同链可再 followup（pendingReplies 键安全——spec §2.2 不变量 1）
    handleTaskReply({ task_id: CHAIN, status: 'completed', body: '答一', tool_calls_used: 1 });
    await expect(p1).resolves.toEqual({ body: '答一', toolCallsUsed: 1 });
  });

  it('同链 bgHandles in_flight → 拒绝；done 句柄不阻塞（bg 链追问合法）', async () => {
    const CHAIN = 'T-chain-bg';
    seedFirstRound(CHAIN);
    __seedBgHandleForTest(CHAIN, { slug: 'ui', status: 'in_flight', startedAt: 1 });
    await expect(
      executeFollowup(CHAIN, '追问', makeConfig(), sessChatId),
    ).rejects.toThrow('上一轮仍在进行中');

    // done（已收割终态）= 上轮已 settle → 放行
    __seedBgHandleForTest(CHAIN, { slug: 'ui', status: 'done', startedAt: 1, body: 'bg 结果', toolCallsUsed: 0, completedAt: 2 });
    const p = executeFollowup(CHAIN, '追问 bg 链', makeConfig(), sessChatId);
    handleTaskReply({ task_id: CHAIN, status: 'completed', body: 'bg 续答', tool_calls_used: 0 });
    await expect(p).resolves.toEqual({ body: 'bg 续答', toolCallsUsed: 0 });
  });

  it('链内只有 owner 行（无子 agent 行）→ 无法定位目标 agent 拒绝', async () => {
    const CHAIN = 'T-chain-owner-only';
    // 构造：上一轮 followup 已写追问行但子 agent 流行缺失（极端清理后形态）
    insertMessage({
      sessionId: sessChatId,
      sender: 'owner',
      eventType: 'm.room.message',
      body: '上一轮问',
      taskId: CHAIN,
      parentStreamSessionId: 'ss-old',
    });
    await expect(
      executeFollowup(CHAIN, '再问', makeConfig(), sessChatId),
    ).rejects.toThrow('无法定位目标 agent');
    expect(dispatchContents()).toHaveLength(0);
  });

  it('目标被移出会话（session_members 删行）→ 既有跨会话错误（assertSessionDispatchAllowed）', async () => {
    const CHAIN = 'T-chain-boundary';
    seedFirstRound(CHAIN);
    getDb()
      .prepare(`DELETE FROM session_members WHERE session_id = ? AND instance_id = 'inst-sub'`)
      .run(sessChatId);
    await expect(
      executeFollowup(CHAIN, '追问', makeConfig(), sessChatId),
    ).rejects.toThrow('目标 agent 不是当前会话成员，不能跨会话委派');
    expect(dispatchContents()).toHaveLength(0);
    expect(followupRows(CHAIN)).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. 成功路径 + degraded + abort
// ══════════════════════════════════════════════════════════════════════════

describe('executeFollowup 成功路径（replay 续接）', () => {
  it('重建前缀 → 追问行落库 → 派发沿用原 taskId + 新 subStream + history_prefix → reply resolve', async () => {
    const CHAIN = 'T-chain-ok';
    seedFirstRound(CHAIN);

    const p = executeFollowup(
      CHAIN,
      '把结论展开成表格',
      makeConfig(),
      sessChatId,
      undefined,
      'ss-pm-cur',
      'ss-r2',
    );

    // 追问 user 行已落库：原文 + 双键打标 + parent = PM 当前流
    const rows = followupRows(CHAIN);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe('把结论展开成表格');
    expect(rows[0]?.parentStreamSessionId).toBe('ss-pm-cur');

    // 派发 content：沿用原链 taskId（不是新 UUID）+ 重建前缀 + 新 subStream
    const contents = dispatchContents();
    expect(contents).toHaveLength(1);
    const c = contents[0];
    expect(c?.task_id).toBe(CHAIN);
    expect(c?.body).toBe('把结论展开成表格');
    expect(c?.dispatch_from).toBe('inst-pm');
    expect(c?.dispatch_to).toBe('inst-sub');
    expect(c?.tool_stream_session_id).toBe('ss-pm-cur');
    expect(c?.sub_stream_session_id).toBe('ss-r2');
    expect(c?.history_prefix).toEqual([{ role: 'assistant', content: '首轮结论' }]);

    // 事件发往当前执行会话 + sender 是 PM 本地身份
    const evt = sentEvents.find((e) => e.eventType === 'io.momo-studio.dispatch');
    expect(evt?.sessionId).toBe(sessChatId);
    expect(evt?.sender).toBe('agent-pm-01');

    // 同步等 reply（pendingReplies 注册 + 渐进超时语义同 executeDispatch）
    handleTaskReply({ task_id: CHAIN, status: 'completed', body: '二轮答复', tool_calls_used: 2 });
    await expect(p).resolves.toEqual({ body: '二轮答复', toolCallsUsed: 2 });
  });

  it('degraded（链行只有分段快照，重建器双键空链降级）→ 前缀缺席 + question 前缀提示；落库原文', async () => {
    const CHAIN = 'T-chain-deg';
    // 只 seed segment 快照行：链存在（task_id+session 有行）但 queryChainRows
    // 过滤 segment_of IS NULL 后为空 → rebuildSubConversation 降级
    insertMessage({
      sessionId: sessChatId,
      sender: 'agent-inst-sub',
      eventType: 'm.room.message',
      body: '分段快照',
      taskId: CHAIN,
      segmentOf: 'ss-base-ghost',
    });

    // 不传 subStreamSessionId → 执行体自生成（新 chip 查找键）
    const p = executeFollowup(CHAIN, '追问细节', makeConfig(), sessChatId, undefined, 'ss-pm-deg');
    handleTaskReply({ task_id: CHAIN, status: 'completed', body: '降级答复', tool_calls_used: 0 });

    const r = await p;
    expect(r).toEqual({ body: '降级答复', toolCallsUsed: 0 });

    const c = dispatchContents()[0];
    expect(c?.task_id).toBe(CHAIN);
    // 降级：body 前缀提示 + history_prefix 字段缺席（T2 语义：空数组等价无前缀）
    expect(c?.body).toBe('（此前对话历史不可用）\n追问细节');
    expect('history_prefix' in (c ?? {})).toBe(false);
    // 自生成 subStreamSessionId：非空字符串
    expect(typeof c?.sub_stream_session_id).toBe('string');
    expect(String(c?.sub_stream_session_id).length).toBeGreaterThan(0);
    // 落库行是用户原文（提示只注入派发 body，不污染链历史）
    expect(followupRows(CHAIN)[0]?.body).toBe('追问细节');
  });

  it('abort signal：onAbort 清理 pendingReplies + reject(AbortError) + 发 abort_dispatch（携带新 subStream）', async () => {
    const CHAIN = 'T-chain-abort';
    seedFirstRound(CHAIN);
    const ac = new AbortController();

    const p = executeFollowup(CHAIN, '问', makeConfig(), sessChatId, ac.signal, 'ss-pm-ab', 'ss-r2ab');
    ac.abort();

    await expect(p).rejects.toMatchObject({ name: 'AbortError' });

    // abort_dispatch 兜底事件已发（routeAbortDispatch 以 subStreamSessionId 定位）
    const abortEvt = sentEvents.find((e) => e.eventType === 'io.momo-studio.abort_dispatch');
    expect(abortEvt).toBeDefined();
    expect(abortEvt?.content.task_id).toBe(CHAIN);
    expect(abortEvt?.content.sub_stream_session_id).toBe('ss-r2ab');

    // pendingReplies 已清理：reply 到达走「迟到」warn 路径（不复活 promise）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      handleTaskReply({ task_id: CHAIN, status: 'completed', body: '迟到', tool_calls_used: 0 });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('迟到的 task_reply');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. 接线锁：history_prefix 的主进程两跳（routeDispatch → agent-runner）
// ══════════════════════════════════════════════════════════════════════════

describe('routeDispatch history_prefix 映射（主进程接线锁）', () => {
  /** 经 RouterService.routeEvent 路由一条 dispatch，捕获 runner 收到的 TaskConfig */
  async function routeDispatchCapture(
    content: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    const captured: Array<Record<string, unknown>> = [];
    const runner = {
      executeTask: async (t: { streamSessionId: string }): Promise<{ streamSessionId: string }> => {
        captured.push(t as unknown as Record<string, unknown>);
        return { streamSessionId: t.streamSessionId };
      },
    } as unknown as AgentRunner;
    const svc = new RouterService({ runners: new Map([['inst-sub', runner]]) });
    await svc.routeEvent(
      {
        getType: () => 'io.momo-studio.dispatch',
        getContent: () => content,
        getSender: () => 'agent-pm-01',
        getRoomId: () => sessChatId,
      },
      'owner',
      null,
      'inst-sub',
    );
    return captured;
  }

  it('合法 history_prefix → TaskConfig.historyPrefix 原样就位；taskId 与 dispatchContext.task_id 同值双设', async () => {
    const prefix = [
      { role: 'assistant', content: '首轮结论' },
      { role: 'user', content: '上一问' },
    ];
    const tasks = await routeDispatchCapture({
      body: '追问',
      task_id: 'T-chain-route',
      dispatch_from: 'inst-pm',
      dispatch_to: 'inst-sub',
      sub_stream_session_id: 'ss-sub-route',
      tool_stream_session_id: 'ss-pm-route',
      history_prefix: prefix,
    });
    expect(tasks).toHaveLength(1);
    const t = tasks[0];
    expect(t?.taskId).toBe('T-chain-route');
    expect(t?.historyPrefix).toEqual(prefix);
    expect(t?.body).toBe('追问');
    expect(t?.streamSessionId).toBe('ss-sub-route');
    expect(t?.executionSessionId).toBe(sessChatId);
    // T5 review 同值双设锁：routeDispatch 把链 ID 同时放 taskId 与 dispatchContext
    expect((t?.dispatchContext as { task_id?: string } | undefined)?.task_id).toBe('T-chain-route');
  });

  it('非法 history_prefix（角色枚举外）→ 丢弃字段不拒整条（dispatch 仍派发）', async () => {
    const tasks = await routeDispatchCapture({
      body: '追问',
      task_id: 'T-chain-bad',
      dispatch_from: 'inst-pm',
      dispatch_to: 'inst-sub',
      history_prefix: [{ role: 'bogus', content: 'x' }, { role: 'user', content: 'y' }],
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.historyPrefix).toBeUndefined();
    expect(tasks[0]?.body).toBe('追问');
  });

  it('未携带 history_prefix → TaskConfig 无该字段（既有 dispatch 零变化）', async () => {
    const tasks = await routeDispatchCapture({
      body: '任务',
      task_id: 'T-chain-plain',
      dispatch_from: 'inst-pm',
      dispatch_to: 'inst-sub',
    });
    expect(tasks).toHaveLength(1);
    expect('historyPrefix' in (tasks[0] ?? {})).toBe(false);
  });
});

describe('AgentRunner.executeTask historyPrefix 透传（task-config 接线锁）', () => {
  /** mock 子进程（agent-runner.test.ts 同款语义：运行中 exitCode=null / connected=true） */
  function mkChild(): ChildProcess & { send: ReturnType<typeof vi.fn> } {
    return {
      pid: 12345,
      on: vi.fn(),
      off: vi.fn(),
      send: vi.fn(() => true),
      kill: vi.fn(),
      connected: true,
      exitCode: null,
    } as unknown as ChildProcess & { send: ReturnType<typeof vi.fn> };
  }

  it('携带 historyPrefix → child.send 的 task-config 含该字段（verbatim 透传）', async () => {
    const child = mkChild();
    const pool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await pool.warm('inst-sub');
    const runner = new AgentRunnerCtor({
      agentAssignmentId: 'inst-sub',
      agentUserId: 'agent-inst-sub',
      workspaceId: 'ws',
      warmPool: pool,
    });
    const prefix: LLMMessage[] = [{ role: 'assistant', content: '前史' }];

    await runner.executeTask({
      taskId: 'T-chain-fwd',
      executionSessionId: sessChatId,
      body: '问',
      streamSessionId: 'ss-fwd',
      historyPrefix: prefix,
    });

    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task-config',
        historyPrefix: prefix,
        taskId: 'T-chain-fwd',
      }),
    );
  });

  it('未携带 historyPrefix → 发送载荷无该字段（wire 零变化）', async () => {
    const child = mkChild();
    const pool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await pool.warm('inst-sub');
    const runner = new AgentRunnerCtor({
      agentAssignmentId: 'inst-sub',
      agentUserId: 'agent-inst-sub',
      workspaceId: 'ws',
      warmPool: pool,
    });

    await runner.executeTask({
      taskId: null,
      executionSessionId: sessChatId,
      body: 'hi',
      streamSessionId: 'ss-fwd-plain',
    });

    const sentCalls = (child.send as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const cfgMsg = sentCalls
      .map((c) => c[0] as { type?: string })
      .find((m) => m?.type === 'task-config');
    expect(cfgMsg).toBeDefined();
    expect('historyPrefix' in (cfgMsg ?? {})).toBe(false);
  });
});
