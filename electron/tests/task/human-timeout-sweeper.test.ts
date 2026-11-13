// electron/tests/task/human-timeout-sweeper.test.ts
//
// 人工请求超时 sweeper 五策略契约锁（任务生命周期 v2 Task 12，spec §6 HITL 超时）。
// 覆盖（brief Step 1 八用例）：
//   1) deny_and_wrap 到期：请求 answered（answered_by='system:timeout'，
//      answer={decision:'deny'}）+ tool_gate 回调触发 + run/任务保持（不失败不取消）
//   2) keep_waiting 到期：状态不变 + lastRemindedAt 写入（任务/run 不动）
//   3) fail 到期：请求 expired + failRun（任务 failed / run failed / 原因落账）
//   4) cancel 到期：请求 expired + 任务 cancelled / run cancelled
//   5) escalate 到期：状态不变（P1 无跨节点，仅提醒；authority 上抛留 P2）
//      + lastRemindedAt 写入
//   6) 已答不触发：答复过的请求退出超期扫描（processed=0，状态不被改写）
//   7) 提醒判重：同一 deadline 周期内只提醒一次；deadline 后移后可再提醒
//   8) 无任务请求（task_id null）fail/cancel：只 markExpired 请求本身，任务动作跳过
// 隔离：沿 lifecycle-runs-human.test.ts 形态——每 case 独立 tmp 目录 + closeDb；
// DB 真实（deadline 经入参注入控制），本套件不含消息注入路径，无需打桩 router/push。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';
import { getActiveRun, getRun } from '../../src/main/storage/tasks/runs-repo';
import {
  insertHumanRequest,
  getHumanRequest,
  tryAnswer,
} from '../../src/main/storage/tasks/human-requests-repo';
import type { HumanRequestKind, HumanTimeoutPolicy } from '../../src/main/storage/tasks/human-requests-repo';
import {
  startRun,
  enterWaitingHuman,
  setToolGateHandler,
} from '../../src/main/task/lifecycle-runs';
import type { HumanAnswerInput } from '../../src/main/task/human-answer-inject';
import { sweepHumanTimeouts } from '../../src/main/task/human-timeout-sweeper';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-human-timeout-sweeper-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

// human_requests.session_id 有 FK → sessions；sweeper 请求种子的会话父行
let hitlSessionId = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  hitlSessionId = insertSessionSeed();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 会话父行（沿用 storage 测试的裸 INSERT 形态——sweeper 用例不涉会话成员/唤醒） */
function insertSessionSeed(): string {
  const id = `ses-${Math.random().toString(36).slice(2)}`;
  getDb()
    .prepare(
      `INSERT INTO sessions (id, workspace_id, title, kind, created_at, updated_at)
       VALUES (?, ?, 'sweeper', 'chat', 0, 0)`,
    )
    .run(id, 'ws1');
  return id;
}

/** 种一个 assigned 任务（生产合法起点：assigned → in_progress 由 startRun 投影） */
function seedAssignedTask(): string {
  return insertTask({
    workspaceId: 'ws1',
    title: 'T',
    creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-leader',
    status: 'assigned',
  }).id;
}

/** 种一个已到期（deadline 已过）的 pending 请求，策略显式指定 */
function seedDueRequest(opts: {
  timeoutPolicy: HumanTimeoutPolicy;
  kind?: HumanRequestKind;
  taskId?: string | null;
  runId?: string | null;
}): { id: string } {
  return insertHumanRequest({
    sessionId: hitlSessionId,
    kind: opts.kind ?? 'question',
    title: '超时请求',
    taskId: opts.taskId ?? null,
    runId: opts.runId ?? null,
    deadlineAt: Date.now() - 1000,
    timeoutPolicy: opts.timeoutPolicy,
  });
}

/** 种一个到期但晚于 seedDueRequest 的行（listDue 按 deadline ASC——排在种子行之后） */
function seedLateDueRequest(opts: { timeoutPolicy: HumanTimeoutPolicy }): { id: string } {
  return insertHumanRequest({
    sessionId: hitlSessionId,
    kind: 'question',
    title: '晚到请求',
    deadlineAt: Date.now() - 500,
    timeoutPolicy: opts.timeoutPolicy,
  });
}

describe('1) deny_and_wrap：system:timeout 拒绝答复 + 回调派发 + run 保持', () => {
  it('请求 answered + 回调收到 (id, deny) + 任务/run 不被失败', () => {
    const taskId = seedAssignedTask();
    startRun(taskId, { trigger: 'initial' });
    enterWaitingHuman(taskId); // 生产形态：tool_gate 等人挂起（run/task 均 waiting_human）
    const req = seedDueRequest({ timeoutPolicy: 'deny_and_wrap', kind: 'tool_gate', taskId });

    const calls: Array<[string, HumanAnswerInput]> = [];
    setToolGateHandler((id, ans) => {
      calls.push([id, ans]);
    });

    const res = sweepHumanTimeouts();
    setToolGateHandler(null);

    expect(res).toEqual({ processed: 1 });
    const row = getHumanRequest(req.id)!;
    expect(row.status).toBe('answered');
    expect(row.answeredByNodeId).toBe('system:timeout');
    expect(JSON.parse(row.answerJson!)).toEqual({ decision: 'deny' });
    expect(calls).toEqual([[req.id, { decision: 'deny' }]]);
    // run 保持：sweeper 不失败不取消——收尾由回调侧（Task 13）负责
    expect(getActiveRun(taskId)!.status).toBe('waiting_human');
    expect(getTask(taskId)!.status).toBe('waiting_human');
  });
});

describe('2) keep_waiting：状态不变 + lastRemindedAt 写入', () => {
  it('请求仍 pending + 提醒时刻落库 + 任务/run 不动', () => {
    const taskId = seedAssignedTask();
    startRun(taskId, { trigger: 'initial' });
    const req = seedDueRequest({ timeoutPolicy: 'keep_waiting', taskId });

    const now = Date.now();
    const res = sweepHumanTimeouts(now);

    expect(res.processed).toBe(1);
    const row = getHumanRequest(req.id)!;
    expect(row.status).toBe('pending');
    expect(row.lastRemindedAt).toBe(now);
    expect(getTask(taskId)!.status).toBe('in_progress');
    expect(getActiveRun(taskId)!.status).toBe('running');
  });
});

describe('3) fail：请求 expired + 任务失败收尾', () => {
  it('请求 expired + failRun（任务 failed / run failed / 原因落账）', () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });
    const req = seedDueRequest({ timeoutPolicy: 'fail', taskId });

    sweepHumanTimeouts();

    expect(getHumanRequest(req.id)!.status).toBe('expired');
    expect(getTask(taskId)!.status).toBe('failed');
    expect(getTask(taskId)!.errorMessage).toBe('人工请求超时');
    expect(getRun(run.id)!.status).toBe('failed');
  });
});

describe('4) cancel：请求 expired + 任务取消收尾', () => {
  it('请求 expired + cancelActiveRun（任务 cancelled / run cancelled）', () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });
    const req = seedDueRequest({ timeoutPolicy: 'cancel', taskId });

    sweepHumanTimeouts();

    expect(getHumanRequest(req.id)!.status).toBe('expired');
    expect(getTask(taskId)!.status).toBe('cancelled');
    expect(getRun(run.id)!.status).toBe('cancelled');
    expect(getRun(run.id)!.rejectReason).toBe('人工请求超时');
  });
});

describe('5) escalate：P1 仅提醒（no-op + lastRemindedAt）', () => {
  it('请求仍 pending + 提醒时刻落库，任务/run 不动', () => {
    const taskId = seedAssignedTask();
    startRun(taskId, { trigger: 'initial' });
    const req = seedDueRequest({ timeoutPolicy: 'escalate', taskId });

    const now = Date.now();
    sweepHumanTimeouts(now);

    const row = getHumanRequest(req.id)!;
    expect(row.status).toBe('pending');
    expect(row.lastRemindedAt).toBe(now);
    expect(getTask(taskId)!.status).toBe('in_progress');
    expect(getActiveRun(taskId)!.status).toBe('running');
  });
});

describe('6) 已答不触发', () => {
  it('答复过的请求退出超期扫描：processed=0、状态不被改写', () => {
    const req = seedDueRequest({ timeoutPolicy: 'fail' });
    tryAnswer(req.id, '{"text":"人先答了"}', 'user:local');

    const res = sweepHumanTimeouts();

    expect(res.processed).toBe(0);
    const row = getHumanRequest(req.id)!;
    expect(row.status).toBe('answered');
    expect(row.answerJson).toBe('{"text":"人先答了"}');
    expect(row.lastRemindedAt).toBeNull();
  });
});

describe('7) 提醒判重：同一 deadline 周期一次；deadline 后移可再提醒', () => {
  it('二次 sweep 不重复提醒；deadline 更新后再提醒一次', () => {
    const req = seedDueRequest({ timeoutPolicy: 'keep_waiting' });

    const t1 = Date.now();
    sweepHumanTimeouts(t1);
    expect(getHumanRequest(req.id)!.lastRemindedAt).toBe(t1);

    // 同一 deadline 周期内第二次 sweep：不重复提醒
    const t2 = t1 + 60_000;
    sweepHumanTimeouts(t2);
    expect(getHumanRequest(req.id)!.lastRemindedAt).toBe(t1);

    // deadline 后移（晚于上次提醒）→ 新提醒周期
    const t3 = t2 + 60_000;
    getDb().prepare(`UPDATE human_requests SET deadline_at = ? WHERE id = ?`).run(t3, req.id);
    sweepHumanTimeouts(t3);
    expect(getHumanRequest(req.id)!.lastRemindedAt).toBe(t3);
  });
});

describe('8) 无任务请求（task_id null）fail/cancel：只动请求本身', () => {
  it('两条会话级请求分别 expired，任务动作跳过不抛', () => {
    const failReq = seedDueRequest({ timeoutPolicy: 'fail' });
    const cancelReq = seedDueRequest({ timeoutPolicy: 'cancel' });

    const res = sweepHumanTimeouts();

    expect(res.processed).toBe(2);
    expect(getHumanRequest(failReq.id)!.status).toBe('expired');
    expect(getHumanRequest(cancelReq.id)!.status).toBe('expired');
  });
});

// ═══ T13 加固（同 commit 强制项）：单行毒化隔离 + acceptance 不走自动拒 ═══
describe('9) 毒行隔离：单行处置异常不饿死后续行', () => {
  it('handler 抛错的到期行被捕获跳过（异常不外溢），后续行照常处置', () => {
    // 早 deadline 的毒行（listDue 按 deadline ASC——毒行在前）
    const poison = seedDueRequest({ timeoutPolicy: 'deny_and_wrap', kind: 'tool_gate' });
    seedLateDueRequest({ timeoutPolicy: 'keep_waiting' });
    setToolGateHandler(() => {
      throw new Error('boom');
    });
    try {
      expect(() => sweepHumanTimeouts()).not.toThrow();
      // 毒行答复已落库（tryAnswer 先于回调），仅回调侧动作中断
      expect(getHumanRequest(poison.id)!.status).toBe('answered');
    } finally {
      setToolGateHandler(null);
    }
    // 后续行未被饿死：keep_waiting 提醒照写
    const late = getDb()
      .prepare(`SELECT * FROM human_requests WHERE timeout_policy = 'keep_waiting'`)
      .get() as { last_reminded_at: number | null } | undefined;
    expect(late?.last_reminded_at).not.toBeNull();
  });
});

describe('10) deny_and_wrap 跳过 acceptance 行（配置防线）', () => {
  it('acceptance 误配 deny_and_wrap → 跳过不抛、行保持 pending，后续行照常处置', () => {
    const acceptance = seedDueRequest({ timeoutPolicy: 'deny_and_wrap', kind: 'acceptance' });
    const normal = seedDueRequest({ timeoutPolicy: 'deny_and_wrap', kind: 'tool_gate' });

    expect(() => sweepHumanTimeouts()).not.toThrow();

    // acceptance 不走 answerHuman 自动拒（其通道守卫会抛——显式跳过）
    expect(getHumanRequest(acceptance.id)!.status).toBe('pending');
    // 正常 tool_gate 行照常 system:timeout 拒绝
    expect(getHumanRequest(normal.id)!.status).toBe('answered');
    expect(getHumanRequest(normal.id)!.answeredByNodeId).toBe('system:timeout');
  });
});
