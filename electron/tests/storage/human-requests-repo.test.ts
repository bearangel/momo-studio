// electron/tests/storage/human-requests-repo.test.ts
//
// human_requests repo CRUD 测试（任务生命周期 v2，spec §5.5 / §6 HITL）。
// 覆盖：
//   1) insertHumanRequest / getHumanRequest 往返（timeout_policy 缺省 keep_waiting、
//      status 缺省 pending、prompt 缺省空串）；全字段可选透传
//   2) tryAnswer 原子防双答：两次答复只有第一次 ok，第二次
//      {ok:false, reason:'not_pending'}；不存在 id → not_found；已答内容不被覆盖
//   3) supersedePendingByRun 只翻非验收 pending → superseded（acceptance 不动）；幂等计数 0
//   4) listPendingBySession 按 created_at ASC、不含 answered
//   5) listDue 命中 deadline_at <= now 的 pending 行；未设 deadline 不命中；已答不命中
//   6) 镜像唯一：同 (origin_node_id, remote_id) 第二次 insert 抛 UNIQUE 冲突；
//      本地行两列皆 NULL——SQLite UNIQUE 只在两列均非 NULL 时去重，本地行任意多条
// 测试隔离：独立 tmp 目录 + closeDb + AP_USER_DATA_DIR 重置；FK 开启，
// workspaces / sessions / tasks / task_runs 父行逐 case 种子。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask } from '../../src/main/storage/tasks/repo';
import { insertRun } from '../../src/main/storage/tasks/runs-repo';
import {
  insertHumanRequest,
  getHumanRequest,
  listPendingBySession,
  listByTask,
  countPendingNonAcceptance,
  tryAnswer,
  markExpired,
  markReminded,
  supersedePendingByRun,
  cancelPendingByTask,
  listDue,
} from '../../src/main/storage/tasks/human-requests-repo';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-human-req-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // seed workspace（sessions/tasks 表 FK 到 workspaces）
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  // seed session（human_requests.session_id FK → sessions.id）
  getDb()
    .prepare(
      `INSERT INTO sessions (id, workspace_id, title, kind, created_at, updated_at)
       VALUES (?, ?, ?, 'chat', ?, ?)`,
    )
    .run('ses1', 'ws1', 't', 0, 0);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 种任务父行（human_requests.task_id FK → tasks.id），返回任务 id */
function seedTask(): string {
  return insertTask({ workspaceId: 'ws1', title: 'T', creatorUserId: '@owner:home' }).id;
}

/** 种 run 父行（human_requests.run_id FK → task_runs.id），返回 run id */
function seedRun(taskId: string): string {
  return insertRun({ taskId, status: 'running', trigger: 'initial' }).id;
}

describe('human_requests repo', () => {
  it('insert/get 往返：缺省 status=pending、timeout_policy=keep_waiting、prompt 空串', () => {
    const r = insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: '用哪个方案？' });
    const got = getHumanRequest(r.id);
    expect(got).not.toBeNull();
    expect(got).toMatchObject({
      id: r.id,
      sessionId: 'ses1',
      kind: 'question',
      status: 'pending',
      title: '用哪个方案？',
      prompt: '',
      timeoutPolicy: 'keep_waiting',
      taskId: null,
      runId: null,
      deadlineAt: null,
      answerJson: null,
      answeredByNodeId: null,
      answeredAt: null,
    });
    expect(got!.createdAt).toBeGreaterThan(0);
    expect(got!.updatedAt).toBe(got!.createdAt);
    expect(getHumanRequest('no-such')).toBeNull();
  });

  it('insert 全字段往返（task/run/镜像/载荷/超时策略透传）', () => {
    const taskId = seedTask();
    const runId = seedRun(taskId);
    const r = insertHumanRequest({
      sessionId: 'ses1',
      kind: 'tool_gate',
      title: '放行 rm -rf',
      prompt: '确认执行？',
      taskId,
      runId,
      payloadJson: '{"cmd":"rm -rf"}',
      optionsJson: '["allow","deny"]',
      deadlineAt: 999,
      timeoutPolicy: 'deny_and_wrap',
      assigneeNodeId: 'nodeA',
      authorityJson: '{"level":"ask"}',
    });
    expect(getHumanRequest(r.id)).toMatchObject({
      taskId,
      runId,
      kind: 'tool_gate',
      prompt: '确认执行？',
      payloadJson: '{"cmd":"rm -rf"}',
      optionsJson: '["allow","deny"]',
      deadlineAt: 999,
      timeoutPolicy: 'deny_and_wrap',
      assigneeNodeId: 'nodeA',
      authorityJson: '{"level":"ask"}',
    });
  });

  it('tryAnswer 原子防双答：第二次 not_pending；不存在 not_found；已答内容不被覆盖', () => {
    const r = insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: 'q' });
    expect(tryAnswer(r.id, '{"choice":"a"}', 'nodeA')).toEqual({ ok: true });
    const answered = getHumanRequest(r.id)!;
    expect(answered.status).toBe('answered');
    expect(answered.answerJson).toBe('{"choice":"a"}');
    expect(answered.answeredByNodeId).toBe('nodeA');
    expect(answered.answeredAt).toBeGreaterThan(0);
    // 第二次答复撞原子门闩（WHERE status='pending' 未命中）
    expect(tryAnswer(r.id, '{"choice":"b"}', 'nodeB')).toEqual({ ok: false, reason: 'not_pending' });
    expect(tryAnswer('no-such', '{}', 'n')).toEqual({ ok: false, reason: 'not_found' });
    expect(getHumanRequest(r.id)?.answerJson).toBe('{"choice":"a"}');
  });

  it('supersedePendingByRun 只动非验收 pending（acceptance 保持 pending）；返回条数且幂等', () => {
    const taskId = seedTask();
    const runId = seedRun(taskId);
    const q = insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: 'q', runId });
    const gate = insertHumanRequest({ sessionId: 'ses1', kind: 'tool_gate', title: 'g', runId });
    const acc = insertHumanRequest({ sessionId: 'ses1', kind: 'acceptance', title: 'a', runId });
    expect(supersedePendingByRun(runId)).toBe(2);
    expect(getHumanRequest(q.id)?.status).toBe('superseded');
    expect(getHumanRequest(gate.id)?.status).toBe('superseded');
    expect(getHumanRequest(acc.id)?.status).toBe('pending');
    // 已翻过的不再计（幂等）
    expect(supersedePendingByRun(runId)).toBe(0);
  });

  it('listPendingBySession 按 created_at ASC 返回且不含 answered', async () => {
    const a = insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: 'a' });
    // created_at 是 ms 级时间戳，隔 5ms 保证排序方向可断言
    await new Promise((res) => setTimeout(res, 5));
    const b = insertHumanRequest({ sessionId: 'ses1', kind: 'tool_gate', title: 'b' });
    await new Promise((res) => setTimeout(res, 5));
    const c = insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: 'c' });
    tryAnswer(b.id, '{}', 'n');
    expect(listPendingBySession('ses1').map((r) => r.id)).toEqual([a.id, c.id]);
    expect(listPendingBySession('no-such-session')).toHaveLength(0);
  });

  it('listByTask 只回该任务的请求', () => {
    const t1 = seedTask();
    const t2 = seedTask();
    insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: '1', taskId: t1 });
    insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: '2', taskId: t1 });
    insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: '3', taskId: t2 });
    expect(listByTask(t1)).toHaveLength(2);
    expect(listByTask(t2)).toHaveLength(1);
    expect(listByTask('no-such-task')).toHaveLength(0);
  });

  it('countPendingNonAcceptance 统计 run 下非验收 pending 数', () => {
    const taskId = seedTask();
    const runId = seedRun(taskId);
    insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: 'q', runId });
    insertHumanRequest({ sessionId: 'ses1', kind: 'acceptance', title: 'a', runId });
    insertHumanRequest({ sessionId: 'ses1', kind: 'tool_gate', title: 'g', runId });
    expect(countPendingNonAcceptance(runId)).toBe(2);
    // 无 run 关联的行不计入
    insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: 'x' });
    expect(countPendingNonAcceptance(runId)).toBe(2);
    expect(countPendingNonAcceptance('no-such-run')).toBe(0);
  });

  it('listDue 命中 deadline_at <= now 的 pending 行；未设 deadline 不命中；已答不命中', () => {
    const due = insertHumanRequest({
      sessionId: 'ses1',
      kind: 'question',
      title: 'due',
      deadlineAt: Date.now() - 1000,
    });
    insertHumanRequest({
      sessionId: 'ses1',
      kind: 'question',
      title: 'future',
      deadlineAt: Date.now() + 60_000,
    });
    insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: 'none' });
    expect(listDue(Date.now()).map((r) => r.id)).toEqual([due.id]);
    // 已答复行退出超期扫描
    tryAnswer(due.id, '{}', 'n');
    expect(listDue(Date.now())).toHaveLength(0);
  });

  it('markExpired 只翻 pending：返回命中条数；已答/已过期幂等 no-op（sweep 窗口竞态防线）', () => {
    const r = insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: 'q', deadlineAt: 1 });
    expect(markExpired(r.id)).toBe(1);
    expect(getHumanRequest(r.id)?.status).toBe('expired');
    // 幂等：已 expired 再翻不命中
    expect(markExpired(r.id)).toBe(0);
    // sweep 窗口竞态：请求已被人工答复后 markExpired 不得误翻 expired
    const a = insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: 'a', deadlineAt: 1 });
    tryAnswer(a.id, '{}', 'n');
    expect(markExpired(a.id)).toBe(0);
    expect(getHumanRequest(a.id)?.status).toBe('answered');
  });

  it('markReminded 写 lastRemindedAt：只动 pending 行（answered 不写）', () => {
    const r = insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: 'q' });
    markReminded(r.id, 12345);
    expect(getHumanRequest(r.id)?.lastRemindedAt).toBe(12345);
    // pending 守卫：已答复行不写提醒时刻
    const a = insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: 'a' });
    tryAnswer(a.id, '{}', 'n');
    markReminded(a.id, 999);
    expect(getHumanRequest(a.id)?.lastRemindedAt).toBeNull();
  });

  it('cancelPendingByTask 只翻该任务 pending，返回条数；无任务行不动', () => {
    const t1 = seedTask();
    insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: '1', taskId: t1 });
    const done = insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: '2', taskId: t1 });
    tryAnswer(done.id, '{}', 'n');
    insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: '3' }); // 无 task 关联
    expect(cancelPendingByTask(t1)).toBe(1);
    // 会话里只剩无任务关联的行仍是 pending
    expect(listPendingBySession('ses1')).toHaveLength(1);
    expect(cancelPendingByTask('no-such-task')).toBe(0);
  });

  it('镜像唯一：同 (originNodeId, remoteId) 第二次 insert 抛 UNIQUE；本地行 (NULL,NULL) 任意多条', () => {
    insertHumanRequest({
      sessionId: 'ses1',
      kind: 'question',
      title: 'm1',
      originNodeId: 'nodeA',
      remoteId: 'rq1',
    });
    expect(() =>
      insertHumanRequest({
        sessionId: 'ses1',
        kind: 'question',
        title: 'm2',
        originNodeId: 'nodeA',
        remoteId: 'rq1',
      }),
    ).toThrow();
    // 本地行两列皆 NULL：SQLite UNIQUE 只在两列均非 NULL 时去重，任意多条互不冲突
    insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: 'l1' });
    insertHumanRequest({ sessionId: 'ses1', kind: 'question', title: 'l2' });
    expect(listPendingBySession('ses1')).toHaveLength(3);
  });
});
