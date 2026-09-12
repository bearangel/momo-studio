// electron/tests/agent/dispatch-bg.test.ts
//
// v2.8.0 Orchestration T3：bgHandles 句柄表 + handleTaskReply 单点收口扩展
// （spec 2026-09-12 orchestration-primitives §4.1-4.2）。锁定语义：
//   - in_flight 句柄收到终态 reply → 翻转 done（body / toolCallsUsed / completedAt 结果缓存）
//   - cancelled 句柄收到迟到 reply → 保留终态、忽略 body（不复活）
//   - done 句柄收到重复 reply → 幂等（首次结果不被覆盖）
//   - gather waiter 在翻转后被唤醒（收到更新后的句柄），唤醒后一次性排空
//   - in_progress reply 是进度通知——不翻转、不唤醒（与 pendingReplies 语义一致）
//   - pendingReplies 命中优先：既有同步 dispatch 的 reply 不进 bg 分支（句柄无副作用）
//   - 双表未命中 → 既有「迟到 reply」warn 路径
//
// v2.8.0 Orchestration T4：异步族执行体（dispatch_bg / gather / status / cancel）。
// 驱动方式（momo-test-rules 保真度）：mock 只落在 process.send 进程边界，
// 句柄表 / handleTaskReply / waiter 机制全部走真实实现；bg 派发经真实
// executeDispatchBg + DB seed 的会话边界（同 dispatch-parallel.test.ts 形态）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import {
  executeDispatch,
  executeDispatchBg,
  executeGather,
  executeStatus,
  executeCancel,
  handleTaskReply,
  getBgHandle,
  listInFlightBg,
  addGatherWaiter,
  __seedBgHandleForTest,
  __resetBgStateForTest,
  BG_HANDLE_LIMIT,
} from '../../src/main/agent/dispatch-wait';
import type { BgHandle, GatherResult } from '../../src/main/agent/dispatch-wait';
import { INTERNAL_EVENT_MSG, type InternalEventMsg } from '../../src/main/agent/internal-event';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';

/** 构造 in_flight 句柄（T4 executeDispatchBg 落地前经测试缝注入的标准形态） */
function inFlight(slug = 'ui'): BgHandle {
  return { slug, status: 'in_flight', startedAt: Date.now() };
}

describe('bgHandles 句柄表 + handleTaskReply bg 分支', () => {
  beforeEach(() => {
    __resetBgStateForTest();
  });

  it('in_flight 句柄 + completed reply → 翻转 done，body/toolCallsUsed/completedAt 填充', () => {
    __seedBgHandleForTest('bg-flip', inFlight());
    const before = Date.now();
    handleTaskReply({ task_id: 'bg-flip', status: 'completed', body: '结果正文', tool_calls_used: 3 });

    const h = getBgHandle('bg-flip');
    expect(h?.status).toBe('done');
    expect(h?.body).toBe('结果正文');
    expect(h?.toolCallsUsed).toBe(3);
    expect(h?.completedAt).toBeDefined();
    expect(h?.completedAt ?? 0).toBeGreaterThanOrEqual(before);
    // 翻转后离开 in_flight 清单
    expect(listInFlightBg().some((x) => x.taskId === 'bg-flip')).toBe(false);
  });

  it('tool_calls_used 缺省按 0 落（与 pendingReplies resolve 路径同规）', () => {
    __seedBgHandleForTest('bg-nobudget', inFlight());
    handleTaskReply({ task_id: 'bg-nobudget', status: 'completed', body: 'ok' });
    expect(getBgHandle('bg-nobudget')?.toolCallsUsed).toBe(0);
  });

  it('in_flight 句柄 + failed reply → 同样翻转 done（失败 body 原样保留供 gather 判读）', () => {
    __seedBgHandleForTest('bg-fail', inFlight());
    handleTaskReply({ task_id: 'bg-fail', status: 'failed', body: '子 agent 执行失败' });
    const h = getBgHandle('bg-fail');
    expect(h?.status).toBe('done');
    expect(h?.body).toBe('子 agent 执行失败');
  });

  it('cancelled 句柄收到迟到 reply → 保留 cancelled 态，body 不落', () => {
    __seedBgHandleForTest('bg-cancelled', { slug: 'ui', status: 'cancelled', startedAt: 1 });
    handleTaskReply({ task_id: 'bg-cancelled', status: 'completed', body: '迟到结果', tool_calls_used: 9 });
    const h = getBgHandle('bg-cancelled');
    expect(h?.status).toBe('cancelled');
    expect(h?.body).toBeUndefined();
    expect(h?.toolCallsUsed).toBeUndefined();
    expect(h?.completedAt).toBeUndefined();
  });

  it('done 句柄收到重复 reply → 幂等，首次结果不被覆盖', () => {
    __seedBgHandleForTest('bg-dup', inFlight());
    handleTaskReply({ task_id: 'bg-dup', status: 'completed', body: '首次', tool_calls_used: 1 });
    handleTaskReply({ task_id: 'bg-dup', status: 'completed', body: '重复', tool_calls_used: 8 });
    const h = getBgHandle('bg-dup');
    expect(h?.body).toBe('首次');
    expect(h?.toolCallsUsed).toBe(1);
  });

  it('in_progress reply 不翻转不唤醒（进度通知语义与 pendingReplies 一致）', () => {
    __seedBgHandleForTest('bg-progress', inFlight());
    let woke = false;
    addGatherWaiter('bg-progress', () => {
      woke = true;
    });
    handleTaskReply({ task_id: 'bg-progress', status: 'in_progress', body: '进行中', progress_pct: 50 });
    const h = getBgHandle('bg-progress');
    expect(h?.status).toBe('in_flight');
    expect(h?.body).toBeUndefined();
    expect(woke).toBe(false);
  });

  it('gather waiter 在翻转后被唤醒收到更新后句柄；唤醒后一次性排空', async () => {
    __seedBgHandleForTest('bg-wake', inFlight());
    const received: BgHandle[] = [];
    const p = new Promise<BgHandle>((resolve) => {
      addGatherWaiter('bg-wake', (h) => {
        received.push(h);
        resolve(h);
      });
    });
    handleTaskReply({ task_id: 'bg-wake', status: 'completed', body: '收割', tool_calls_used: 2 });
    const woken = await p;
    // 唤醒收到的是翻转后的句柄（done + 结果已填充）
    expect(woken.status).toBe('done');
    expect(woken.body).toBe('收割');
    expect(received).toHaveLength(1);
    // waiter 集已排空——后续重复 reply 不再唤醒（幂等）
    handleTaskReply({ task_id: 'bg-wake', status: 'completed', body: '再来一次' });
    expect(received).toHaveLength(1);
  });

  it('listInFlightBg 只列 in_flight 句柄（taskId/slug/startedAt 投影）；BG_HANDLE_LIMIT 锁 8', () => {
    __seedBgHandleForTest('bg-a', { slug: 'ui', status: 'in_flight', startedAt: 111 });
    __seedBgHandleForTest('bg-b', { slug: 'api', status: 'in_flight', startedAt: 222 });
    __seedBgHandleForTest('bg-c', { slug: 'db', status: 'done', startedAt: 333, body: 'x', toolCallsUsed: 0, completedAt: 334 });

    const list = listInFlightBg();
    expect(list).toHaveLength(2);
    expect(list.map((x) => x.taskId).sort()).toEqual(['bg-a', 'bg-b']);
    const a = list.find((x) => x.taskId === 'bg-a');
    expect(a?.slug).toBe('ui');
    expect(a?.startedAt).toBe(111);
    expect(BG_HANDLE_LIMIT).toBe(8);
  });

  it('双表未命中 → 既有 warn 路径', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      handleTaskReply({ task_id: 'totally-unknown', status: 'completed', body: 'x' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('迟到的 task_reply');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// === pendingReplies 命中优先（需要真实 executeDispatch 注册 pending——DB seed 同 dispatch-wait.test.ts） ===

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-dispatch-bg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('pendingReplies 命中优先（既有同步 dispatch 不进 bg 分支）', () => {
  beforeEach(() => {
    // 会话边界校验要求真实 session_members 行：seed ws + agent 链 + 会话
    // sess-chat（inst-pm leader + inst-sub 两成员——dispatch 合法域）
    fs.mkdirSync(tmpRoot, { recursive: true });
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
    const db = getDb();
    db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`).run();
    for (const inst of ['inst-pm', 'inst-sub']) {
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
    const sess = insertSession({ workspaceId: 'ws', title: 'chat' });
    addSessionMember(sess.id, 'inst-pm', true);
    addSessionMember(sess.id, 'inst-sub', false);
    sessChatId = sess.id;

    __resetBgStateForTest();
    sentEvents.length = 0;
    process.send = ((msg: unknown): boolean => {
      const m = msg as InternalEventMsg;
      if (m?.type === INTERNAL_EVENT_MSG) sentEvents.push(m);
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('既有 pendingReplies 注册 + reply → 正常 resolve，bgHandles 无副作用', async () => {
    const p = executeDispatch('ui', '任务', makeConfig(), undefined, 'ss-sub', 'ss-pm', sessChatId);
    const dispatchEvt = sentEvents.find((e) => e.eventType === 'io.momo-studio.dispatch');
    expect(dispatchEvt).toBeDefined();
    const taskId = dispatchEvt?.content.task_id;
    if (typeof taskId !== 'string') throw new Error('dispatch 事件缺 task_id');

    // 防御性同 taskId 双表并存（生产不应出现——bg 派发不注册 pendingReplies）：
    // 若查找顺序被错误颠倒（bg 优先于 pendingReplies），该句柄会被翻转，测试即红
    __seedBgHandleForTest(taskId, inFlight());

    handleTaskReply({ task_id: taskId, status: 'completed', body: '同步结果', tool_calls_used: 2 });
    const r = await p;
    expect(r).toEqual({ body: '同步结果', toolCallsUsed: 2 });

    // bg 句柄未被触碰（不进 bg 分支）
    const h = getBgHandle(taskId);
    expect(h?.status).toBe('in_flight');
    expect(h?.body).toBeUndefined();
  });
});

// === v2.8.0 T4：异步族执行体（bg / gather / status / cancel） ===

describe('executeDispatchBg 异步派发执行体', () => {
  beforeEach(() => {
    // 会话边界校验要求真实 session_members 行（同上方 describe 的 seed 形态）：
    // ws + agent 链 + 会话（inst-pm leader + inst-sub 两成员）
    fs.mkdirSync(tmpRoot, { recursive: true });
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
    const db = getDb();
    db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`).run();
    for (const inst of ['inst-pm', 'inst-sub']) {
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
    const sess = insertSession({ workspaceId: 'ws', title: 'bg' });
    addSessionMember(sess.id, 'inst-pm', true);
    addSessionMember(sess.id, 'inst-sub', false);
    sessChatId = sess.id;

    __resetBgStateForTest();
    sentEvents.length = 0;
    process.send = ((msg: unknown): boolean => {
      const m = msg as InternalEventMsg;
      if (m?.type === INTERNAL_EVENT_MSG) sentEvents.push(m);
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('派发即返：注册 in_flight 句柄、不注册 pendingReplies、事件发往当前执行会话', async () => {
    const r = await executeDispatchBg('ui', '后台任务', makeConfig(), 5, 'ss-sub', 'ss-pm', sessChatId);

    const dispatchEvt = sentEvents.find((e) => e.eventType === 'io.momo-studio.dispatch');
    expect(dispatchEvt).toBeDefined();
    // 返回的 taskId 即 dispatch 事件的 task_id（taskId = 句柄，不另造 ID 空间）
    expect(r.taskId).toBe(dispatchEvt?.content.task_id);
    expect(dispatchEvt?.sessionId).toBe(sessChatId);
    expect(dispatchEvt?.sender).toBe('agent-pm-01');
    expect(dispatchEvt?.content.dispatch_to).toBe('inst-sub');
    expect(dispatchEvt?.content.body).toBe('后台任务');
    expect(dispatchEvt?.content.tool_budget).toBe(5);
    expect(dispatchEvt?.content.sub_stream_session_id).toBe('ss-sub');
    expect(dispatchEvt?.content.tool_stream_session_id).toBe('ss-pm');

    const h = getBgHandle(r.taskId);
    expect(h?.slug).toBe('ui');
    expect(h?.status).toBe('in_flight');
    // 句柄存 subStreamSessionId——dispatch_cancel 发 abort_dispatch 的定位键
    expect(h?.subStreamSessionId).toBe('ss-sub');
    expect(listInFlightBg().some((x) => x.taskId === r.taskId)).toBe(true);

    // 不注册 pendingReplies 的证明：reply 走 bg 分支翻转句柄。若误注册 pending，
    // reply 会被 pending 分支消费、句柄保持 in_flight（对照上方「pendingReplies
    // 命中优先」用例的反向断言）
    handleTaskReply({ task_id: r.taskId, status: 'completed', body: '异步结果', tool_calls_used: 2 });
    expect(getBgHandle(r.taskId)?.status).toBe('done');
    expect(getBgHandle(r.taskId)?.body).toBe('异步结果');
  });

  it('会话边界失败 → 抛错、句柄不建、不发事件', async () => {
    await expect(
      executeDispatchBg('ui', '任务', makeConfig(), undefined, 'ss-sub', 'ss-pm', 'sess-不存在的会话'),
    ).rejects.toThrow('当前会话不支持委派');
    expect(listInFlightBg()).toEqual([]);
    expect(sentEvents.filter((e) => e.eventType === 'io.momo-studio.dispatch')).toHaveLength(0);
  });

  it('在途 ≥ 8 → 第 9 个派发抛错（含在途清单），不建句柄不发事件', async () => {
    for (let i = 1; i <= BG_HANDLE_LIMIT; i++) {
      __seedBgHandleForTest(`lim-${i}`, inFlight(`ui-${i}`));
    }
    let err: unknown;
    try {
      await executeDispatchBg('ui', '第 9 个任务', makeConfig(), undefined, 'ss-sub', 'ss-pm', sessChatId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = String(err);
    expect(msg).toContain('在途后台任务已达上限');
    // 清单列出在途 taskId + slug（listInFlightBg 投影），教 LLM 先 gather/cancel
    expect(msg).toContain('lim-1');
    expect(msg).toContain('lim-8');
    expect(msg).toContain('gather');
    expect(listInFlightBg()).toHaveLength(BG_HANDLE_LIMIT);
    expect(sentEvents).toHaveLength(0);
  });

  it('迟到缓存：bg 派发 → reply(done) → gather 立即命中（不挂起）', async () => {
    const { taskId } = await executeDispatchBg('ui', '迟到任务', makeConfig(), undefined, 'ss-sub', 'ss-pm', sessChatId);
    handleTaskReply({ task_id: taskId, status: 'completed', body: '迟到结果', tool_calls_used: 4 });
    const r = await executeGather([taskId], 'all', 30000);
    expect(r.done).toEqual([{ taskId, status: 'done', body: '迟到结果', toolCallsUsed: 4 }]);
    expect(r.pending).toEqual([]);
    expect(r.notes).toEqual([]);
  });
});

describe('executeGather 收割语义', () => {
  beforeEach(() => {
    __resetBgStateForTest();
  });

  it('all：全部 settle 才返回（部分翻转不提前醒）', async () => {
    __seedBgHandleForTest('g1', inFlight());
    __seedBgHandleForTest('g2', inFlight());
    const p = executeGather(['g1', 'g2'], 'all', 30000);
    let out: GatherResult | undefined;
    p.then((r) => {
      out = r;
    });
    handleTaskReply({ task_id: 'g1', status: 'completed', body: 'A', tool_calls_used: 1 });
    await Promise.resolve();
    expect(out).toBeUndefined();
    handleTaskReply({ task_id: 'g2', status: 'completed', body: 'B', tool_calls_used: 2 });
    const r = await p;
    expect(r.pending).toEqual([]);
    expect(r.done).toHaveLength(2);
    expect(r.done.map((d) => d.taskId).sort()).toEqual(['g1', 'g2']);
    for (const d of r.done) {
      expect(d.status).toBe('done');
      expect(d.body).toBe(d.taskId === 'g1' ? 'A' : 'B');
      expect(d.toolCallsUsed).toBe(d.taskId === 'g1' ? 1 : 2);
    }
    // 收割条目是快照副本而非句柄引用（T3 review Minor 纪律）
    expect(r.done.find((d) => d.taskId === 'g1')).not.toBe(getBgHandle('g1'));
  });

  it('any：首个 settle 即返回，其余进 pending', async () => {
    __seedBgHandleForTest('a1', inFlight());
    __seedBgHandleForTest('a2', inFlight());
    const p = executeGather(['a1', 'a2'], 'any', 30000);
    handleTaskReply({ task_id: 'a2', status: 'completed', body: '先完成', tool_calls_used: 1 });
    const r = await p;
    expect(r.done).toEqual([{ taskId: 'a2', status: 'done', body: '先完成', toolCallsUsed: 1 }]);
    expect(r.pending).toEqual(['a1']);
    expect(r.notes).toEqual([]);
  });

  it('超时返回 done+pending 非错误，句柄保留可再 gather（fake timers）', async () => {
    vi.useFakeTimers();
    try {
      __seedBgHandleForTest('t-done', { slug: 'ui', status: 'done', startedAt: 1, body: 'ok', toolCallsUsed: 1, completedAt: 2 });
      __seedBgHandleForTest('t-wait', inFlight());
      const p = executeGather(['t-done', 't-wait'], 'all', 20000);
      let out: GatherResult | undefined;
      p.then((r) => {
        out = r;
      });
      await vi.advanceTimersByTimeAsync(19999);
      expect(out).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      const r = await p;
      expect(r.done.map((d) => d.taskId)).toEqual(['t-done']);
      expect(r.pending).toEqual(['t-wait']);
      expect(getBgHandle('t-wait')?.status).toBe('in_flight');
    } finally {
      vi.useRealTimers();
    }
  });

  it('终态句柄立即收集：done 含 body/toolCallsUsed；any+mixed 不等待', async () => {
    __seedBgHandleForTest('d1', { slug: 'ui', status: 'done', startedAt: 1, body: '结果1', toolCallsUsed: 3, completedAt: 10 });
    __seedBgHandleForTest('d2', { slug: 'api', status: 'done', startedAt: 2, body: '结果2', toolCallsUsed: 4, completedAt: 20 });
    const all = await executeGather(['d1', 'd2'], 'all');
    expect(all.done).toHaveLength(2);
    expect(all.done.map((d) => d.taskId).sort()).toEqual(['d1', 'd2']);
    expect(all.done.find((d) => d.taskId === 'd1')).toEqual({
      taskId: 'd1',
      status: 'done',
      body: '结果1',
      toolCallsUsed: 3,
    });
    expect(all.pending).toEqual([]);

    // any + 已有终态 → 立即返回，在途者进 pending 不阻塞
    __seedBgHandleForTest('w1', inFlight());
    const anyR = await executeGather(['w1', 'd1'], 'any');
    expect(anyR.done.map((d) => d.taskId)).toEqual(['d1']);
    expect(anyR.pending).toEqual(['w1']);
  });

  it('cancelled 句柄收集为恰好 {taskId, status:"cancelled"}（无 body，不阻塞 all）', async () => {
    __seedBgHandleForTest('c1', { slug: 'ui', status: 'cancelled', startedAt: 1, completedAt: 5 });
    __seedBgHandleForTest('c2', { slug: 'ui', status: 'done', startedAt: 2, body: 'ok', toolCallsUsed: 0, completedAt: 6 });
    const r = await executeGather(['c1', 'c2'], 'all');
    expect(r.done.find((d) => d.taskId === 'c1')).toEqual({ taskId: 'c1', status: 'cancelled' });
    expect(r.done.find((d) => d.taskId === 'c2')).toBeDefined();
    expect(r.pending).toEqual([]);
  });

  it('等待中 cancel——句柄翻转 cancelled 唤醒 gather（all 不拖到超时）', async () => {
    __seedBgHandleForTest('cw', { slug: 'ui', status: 'in_flight', startedAt: 1, subStreamSessionId: 'ss-cw' });
    const p = executeGather(['cw'], 'all', 30000);
    executeCancel('cw', makeConfig(), 'sess-cancel');
    const r = await p;
    expect(r.done).toEqual([{ taskId: 'cw', status: 'cancelled' }]);
    expect(r.pending).toEqual([]);
  });

  it('重复 gather 幂等：done 句柄可再收割、句柄不删；输入去重、空输入安全', async () => {
    __seedBgHandleForTest('d1', { slug: 'ui', status: 'done', startedAt: 1, body: 'ok', toolCallsUsed: 2, completedAt: 3 });
    const r1 = await executeGather(['d1'], 'all');
    const r2 = await executeGather(['d1'], 'all');
    expect(r1).toEqual(r2);
    expect(getBgHandle('d1')?.status).toBe('done');
    // 输入重复 taskId 去重（一份收割条目）
    const r3 = await executeGather(['d1', 'd1'], 'all');
    expect(r3.done).toHaveLength(1);
    expect(await executeGather([], 'all')).toEqual({ done: [], pending: [], notes: [] });
  });

  it('not_found 句柄进 notes 不整体失败', async () => {
    __seedBgHandleForTest('ok1', { slug: 'ui', status: 'done', startedAt: 1, body: 'ok', toolCallsUsed: 0, completedAt: 2 });
    const r = await executeGather(['ghost-1', 'ok1', 'ghost-2'], 'all');
    expect(r.notes).toHaveLength(2);
    const joined = r.notes.join('\n');
    expect(r.notes[0]).toContain('不存在');
    expect(joined).toContain('ghost-1');
    expect(joined).toContain('ghost-2');
    expect(r.done.map((d) => d.taskId)).toEqual(['ok1']);
    expect(r.pending).toEqual([]);
  });

  it('timeoutMs 钳制：下限 1000 / 上限 600000（越界钳到边界，fake timers）', async () => {
    vi.useFakeTimers();
    try {
      // 下限：传 100 → 实际等 1000
      __seedBgHandleForTest('k1', inFlight());
      const p1 = executeGather(['k1'], 'all', 100);
      let out1: GatherResult | undefined;
      p1.then((r) => {
        out1 = r;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(out1).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect((await p1).pending).toEqual(['k1']);

      // 上限：传 999999999 → 实际等 600000
      __seedBgHandleForTest('k2', inFlight());
      const p2 = executeGather(['k2'], 'all', 999_999_999);
      let out2: GatherResult | undefined;
      p2.then((r) => {
        out2 = r;
      });
      await vi.advanceTimersByTimeAsync(599_999);
      expect(out2).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect((await p2).pending).toEqual(['k2']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('executeStatus 状态查询', () => {
  beforeEach(() => {
    __resetBgStateForTest();
  });

  it('in_flight → status + elapsedMs，无 body', () => {
    __seedBgHandleForTest('st-1', { slug: 'ui', status: 'in_flight', startedAt: Date.now() - 5000 });
    const r = executeStatus('st-1');
    expect(r.status).toBe('in_flight');
    expect(r.body).toBeUndefined();
    expect(r.toolCallsUsed).toBeUndefined();
    expect(r.elapsedMs).toBeDefined();
    expect(r.elapsedMs ?? 0).toBeGreaterThanOrEqual(5000);
  });

  it('done → status + body + toolCallsUsed + elapsedMs（completedAt - startedAt）', () => {
    __seedBgHandleForTest('st-2', { slug: 'ui', status: 'done', startedAt: 1000, body: '结果', toolCallsUsed: 7, completedAt: 4500 });
    expect(executeStatus('st-2')).toEqual({ status: 'done', body: '结果', toolCallsUsed: 7, elapsedMs: 3500 });
  });

  it('cancelled → 终态视图无 body', () => {
    __seedBgHandleForTest('st-3', { slug: 'ui', status: 'cancelled', startedAt: 100, completedAt: 300 });
    expect(executeStatus('st-3')).toEqual({ status: 'cancelled', elapsedMs: 200 });
  });

  it('not_found → 恰好 {status:"not_found"}', () => {
    expect(executeStatus('ghost')).toEqual({ status: 'not_found' });
  });
});

describe('executeCancel 取消执行体', () => {
  beforeEach(() => {
    __resetBgStateForTest();
    sentEvents.length = 0;
    process.send = ((msg: unknown): boolean => {
      const m = msg as InternalEventMsg;
      if (m?.type === INTERNAL_EVENT_MSG) sentEvents.push(m);
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
  });

  it('in_flight → 发 abort_dispatch（既有链路形态）+ 标 cancelled', () => {
    __seedBgHandleForTest('can-1', { slug: 'ui', status: 'in_flight', startedAt: 100, subStreamSessionId: 'ss-can-1' });
    const r = executeCancel('can-1', makeConfig(), 'sess-cancel');
    expect(r).toEqual({ status: 'cancelled' });
    const abortEvts = sentEvents.filter((e) => e.eventType === 'io.momo-studio.abort_dispatch');
    expect(abortEvts).toHaveLength(1);
    expect(abortEvts[0]?.sessionId).toBe('sess-cancel');
    expect(abortEvts[0]?.sender).toBe('agent-pm-01');
    expect(abortEvts[0]?.content.task_id).toBe('can-1');
    // subStreamSessionId 必须携带——routeAbortDispatch 以它定位子 agent 流（缺字段即丢弃）
    expect(abortEvts[0]?.content.sub_stream_session_id).toBe('ss-can-1');
    const h = getBgHandle('can-1');
    expect(h?.status).toBe('cancelled');
    expect(h?.completedAt).toBeDefined();
  });

  it('已 done → 幂等返回 done，不发 abort、状态不改写', () => {
    __seedBgHandleForTest('can-2', { slug: 'ui', status: 'done', startedAt: 1, body: 'x', toolCallsUsed: 1, completedAt: 2 });
    expect(executeCancel('can-2', makeConfig(), 'sess-cancel')).toEqual({ status: 'done' });
    expect(sentEvents.filter((e) => e.eventType === 'io.momo-studio.abort_dispatch')).toHaveLength(0);
    expect(getBgHandle('can-2')?.status).toBe('done');
    expect(getBgHandle('can-2')?.body).toBe('x');
  });

  it('not_found → {status:"not_found"}，不发事件', () => {
    expect(executeCancel('ghost', makeConfig(), 'sess-cancel')).toEqual({ status: 'not_found' });
    expect(sentEvents).toHaveLength(0);
  });

  it('重复 cancel 幂等——第二次返回终态、不再发 abort 事件', () => {
    __seedBgHandleForTest('can-3', { slug: 'ui', status: 'in_flight', startedAt: 1, subStreamSessionId: 'ss-3' });
    executeCancel('can-3', makeConfig(), 'sess-cancel');
    const second = executeCancel('can-3', makeConfig(), 'sess-cancel');
    expect(second).toEqual({ status: 'cancelled' });
    expect(sentEvents.filter((e) => e.eventType === 'io.momo-studio.abort_dispatch')).toHaveLength(1);
  });
});
