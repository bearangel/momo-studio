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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import {
  executeDispatch,
  handleTaskReply,
  getBgHandle,
  listInFlightBg,
  addGatherWaiter,
  __seedBgHandleForTest,
  __resetBgStateForTest,
  BG_HANDLE_LIMIT,
} from '../../src/main/agent/dispatch-wait';
import type { BgHandle } from '../../src/main/agent/dispatch-wait';
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
