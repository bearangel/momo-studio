// electron/tests/task/lifecycle-runs-core.test.ts
//
// lifecycle-runs 服务核心契约锁（任务生命周期 v2，spec §5.1 不变量 6 / §5.2 / §6.6）。
// 覆盖（brief Step 1 七用例组，真实 DB 无 mock）：
//   1) startRun 建 run#1 + 任务 in_progress + currentRunId 回写
//   2) startRun 幂等（Review Focus #3）：已有活动 run 直接返回既有行不抛不重插
//   3) enterWaitingHuman / resumeFromWaiting 双向 + 任务态联动
//   4) paused 优先：pauseForTask 在 waiting_human 时任务 → paused、run 不动；
//      resumePaused → waiting_human（有未决非验收请求）/ in_progress（无）
//   5) run 终结双路径：failRun（run failed + 请求 superseded + 任务 failed +
//      errorMessage）/ cancelActiveRun（run cancelled + superseded + 任务 cancelled）
//   6) MAX_RUNS_PER_TASK 上限：种 10 个终态 run 后 startRun → 人话 throw
//   7) refreshTaskProjection 同态 no-op 不抛；偏差态重算归位
// 隔离：沿 task-runs-repo.test.ts 形态——每 case 独立 tmp 目录 + closeDb。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, transitionTaskStatus } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { getActiveRun, insertRun, listRuns, updateRun } from '../../src/main/storage/tasks/runs-repo';
import {
  insertHumanRequest,
  getHumanRequest,
  tryAnswer,
} from '../../src/main/storage/tasks/human-requests-repo';
import {
  MAX_RUNS_PER_TASK,
  startRun,
  enterWaitingHuman,
  resumeFromWaiting,
  failRun,
  cancelActiveRun,
  pauseForTask,
  resumePaused,
  refreshTaskProjection,
} from '../../src/main/task/lifecycle-runs';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-lifecycle-runs-core-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

// human_requests.session_id 有 FK → sessions；HITL 请求种子的会话父行
let hitlSessionId = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  hitlSessionId = insertSession({ workspaceId: 'ws1', title: 'HITL', kind: 'chat' }).id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 种一个 assigned 任务（生产合法起点：assigned → in_progress 由 startRun 投影） */
function seedAssignedTask(id?: string): string {
  const t = insertTask({
    ...(id ? { id } : {}),
    workspaceId: 'ws1',
    title: 'T',
    creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1',
    status: 'assigned',
  });
  return t.id;
}

/** 种一条 run 下的未决非验收人工请求（question），返回请求 id */
function seedPendingRequest(taskId: string, runId: string): string {
  return insertHumanRequest({
    sessionId: hitlSessionId,
    kind: 'question',
    title: '需要人工输入',
    taskId,
    runId,
  }).id;
}

describe('1) startRun：建 run#1 + 任务 in_progress + currentRunId 回写', () => {
  it('assigned 任务 startRun → run#1(running/initial) + 任务 in_progress + currentRunId', () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial', executionSessionId: 'ses-x' });

    expect(run.runNo).toBe(1);
    expect(run.status).toBe('running');
    expect(run.trigger).toBe('initial');
    expect(run.executionSessionId).toBe('ses-x');
    expect(run.endedAt).toBeNull();

    const task = getTask(taskId)!;
    expect(task.status).toBe('in_progress');
    expect(task.currentRunId).toBe(run.id);
    expect(getActiveRun(taskId)!.id).toBe(run.id);
  });

  it('任务已在 in_progress（starter 先 transition 的时序）→ 同态跳过不抛，仍建 run', () => {
    const taskId = seedAssignedTask();
    transitionTaskStatus(taskId, 'in_progress', { executionSessionId: 'ses-x' });

    const run = startRun(taskId, { trigger: 'initial', executionSessionId: 'ses-x' });
    expect(run.runNo).toBe(1);
    expect(getTask(taskId)!.status).toBe('in_progress');
    expect(getTask(taskId)!.currentRunId).toBe(run.id);
  });
});

describe('2) startRun 幂等（Review Focus #3）', () => {
  it('已有活动 run → 直接返回既有行，不重插不抛', () => {
    const taskId = seedAssignedTask();
    const existing = insertRun({ taskId, status: 'running', trigger: 'initial' });

    const returned = startRun(taskId, { trigger: 'initial' });

    expect(returned.id).toBe(existing.id);
    expect(returned.runNo).toBe(existing.runNo);
    expect(listRuns(taskId)).toHaveLength(1);
    expect(getTask(taskId)!.status).toBe('in_progress');
    expect(getTask(taskId)!.currentRunId).toBe(existing.id);
  });

  it('活动 run 处于 waiting_human → 同样返回既有行（不新建 run 打断 HITL）', () => {
    const taskId = seedAssignedTask();
    const existing = insertRun({ taskId, status: 'waiting_human', trigger: 'initial' });

    const returned = startRun(taskId);

    expect(returned.id).toBe(existing.id);
    expect(listRuns(taskId)).toHaveLength(1);
  });
});

describe('3) enterWaitingHuman / resumeFromWaiting 双向 + 任务态联动', () => {
  it('enter → run waiting_human + 任务 waiting_human；resume → run running + 任务 in_progress', () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });

    enterWaitingHuman(taskId);
    expect(getActiveRun(taskId)!.status).toBe('waiting_human');
    expect(getTask(taskId)!.status).toBe('waiting_human');

    resumeFromWaiting(taskId);
    expect(getActiveRun(taskId)!.status).toBe('running');
    expect(getTask(taskId)!.status).toBe('in_progress');
    expect(run.id).toBeDefined();
  });
});

describe('4) paused 优先：pauseForTask / resumePaused', () => {
  it('waiting_human 时暂停 → 任务 paused、run 仍 waiting_human（run 不动，spec §6.6）', () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });
    enterWaitingHuman(taskId);

    pauseForTask(taskId, '用户抢占');
    expect(getTask(taskId)!.status).toBe('paused');
    expect(getActiveRun(taskId)!.status, '暂停只改任务态，run 保持等待').toBe('waiting_human');
    expect(getActiveRun(taskId)!.id).toBe(run.id);
  });

  it('resumePaused：有未决非验收请求 → waiting_human；无 → in_progress', () => {
    const taskId = seedAssignedTask();
    startRun(taskId, { trigger: 'initial' });
    enterWaitingHuman(taskId);
    pauseForTask(taskId);

    // 分支一：有未决请求 → 回 waiting_human（HITL 语义优先）
    const reqId = seedPendingRequest(taskId, getActiveRun(taskId)!.id);
    resumePaused(taskId);
    expect(getTask(taskId)!.status).toBe('waiting_human');

    // 答复请求 → 恢复执行 → 再暂停（无未决请求）
    tryAnswer(reqId, JSON.stringify({ text: '继续' }), 'user-1');
    resumeFromWaiting(taskId);
    expect(getTask(taskId)!.status).toBe('in_progress');
    pauseForTask(taskId);

    // 分支二：无未决请求 → 直接回 in_progress
    resumePaused(taskId);
    expect(getTask(taskId)!.status).toBe('in_progress');
  });

  it('in_progress 暂停后 resumePaused → in_progress（无请求直回执行态）', () => {
    const taskId = seedAssignedTask();
    startRun(taskId, { trigger: 'initial' });
    pauseForTask(taskId);
    expect(getTask(taskId)!.status).toBe('paused');

    resumePaused(taskId);
    expect(getTask(taskId)!.status).toBe('in_progress');
  });
});

describe('5) run 终结：failRun / cancelActiveRun', () => {
  it('failRun：run failed(endedAt) + 未决请求 superseded + 任务 failed(errorMessage)', () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });
    const reqId = seedPendingRequest(taskId, run.id);

    failRun(taskId, '子进程崩溃');

    const ended = getActiveRun(taskId);
    expect(ended).toBeNull();
    const row = listRuns(taskId)[0]!;
    expect(row.status).toBe('failed');
    expect(row.endedAt).not.toBeNull();
    expect(getHumanRequest(reqId)!.status).toBe('superseded');
    const task = getTask(taskId)!;
    expect(task.status).toBe('failed');
    expect(task.errorMessage).toBe('子进程崩溃');
  });

  it('cancelActiveRun：run cancelled + 未决请求 superseded + 任务 cancelled', () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });
    const reqId = seedPendingRequest(taskId, run.id);

    cancelActiveRun(taskId, '用户取消');

    expect(getActiveRun(taskId)).toBeNull();
    const row = listRuns(taskId)[0]!;
    expect(row.status).toBe('cancelled');
    expect(row.endedAt).not.toBeNull();
    expect(getHumanRequest(reqId)!.status).toBe('superseded');
    expect(getTask(taskId)!.status).toBe('cancelled');
  });
});

describe('6) MAX_RUNS_PER_TASK 上限', () => {
  it(`种 ${MAX_RUNS_PER_TASK} 个终态 run 后 startRun → 人话 throw（含上限值）`, () => {
    const taskId = seedAssignedTask();
    for (let i = 0; i < MAX_RUNS_PER_TASK; i++) {
      const r = insertRun({ taskId, status: 'running', trigger: 'manual' });
      updateRun(r.id, { status: 'failed', endedAt: Date.now() });
    }
    expect(listRuns(taskId)).toHaveLength(MAX_RUNS_PER_TASK);

    expect(() => startRun(taskId)).toThrow(/上限/);
    expect(() => startRun(taskId)).toThrow(new RegExp(String(MAX_RUNS_PER_TASK)));
    // 上限拒绝零副作用：不插第 11 个 run、任务不转 in_progress
    expect(listRuns(taskId)).toHaveLength(MAX_RUNS_PER_TASK);
    expect(getTask(taskId)!.status).toBe('assigned');
  });

  it('终态 run 不占活动槽但计入上限——9 个终态 + 1 个可闭合后仍受上限约束', () => {
    const taskId = seedAssignedTask();
    for (let i = 0; i < MAX_RUNS_PER_TASK - 1; i++) {
      const r = insertRun({ taskId, status: 'running', trigger: 'manual' });
      updateRun(r.id, { status: 'cancelled', endedAt: Date.now() });
    }
    // 第 10 个：正常 startRun 成功（9 个终态未达上限）
    const run10 = startRun(taskId, { trigger: 'manual' });
    expect(run10.runNo).toBe(MAX_RUNS_PER_TASK);
    // 闭合第 10 个 → 总数仍 10 → 再 startRun 拒绝
    updateRun(run10.id, { status: 'failed', endedAt: Date.now() });
    expect(() => startRun(taskId)).toThrow(/上限/);
  });
});

describe('7) refreshTaskProjection：单点投影', () => {
  it('同态 no-op 不抛：in_progress + running → 保持不变', () => {
    const taskId = seedAssignedTask();
    startRun(taskId, { trigger: 'initial' });

    expect(() => refreshTaskProjection(taskId)).not.toThrow();
    expect(getTask(taskId)!.status).toBe('in_progress');
  });

  it('偏差态重算归位：任务 waiting_human 但 run 已 running → in_progress', () => {
    const taskId = seedAssignedTask();
    startRun(taskId, { trigger: 'initial' });
    enterWaitingHuman(taskId);
    // 人工答复后只把 run 拉回 running（任务态留给投影重算）
    updateRun(getActiveRun(taskId)!.id, { status: 'running' });
    expect(getTask(taskId)!.status).toBe('waiting_human');

    refreshTaskProjection(taskId);
    expect(getTask(taskId)!.status).toBe('in_progress');
  });

  it('paused 不被投影覆盖（§6.6：paused 是用户权威态）', () => {
    const taskId = seedAssignedTask();
    startRun(taskId, { trigger: 'initial' });
    pauseForTask(taskId);

    refreshTaskProjection(taskId);
    expect(getTask(taskId)!.status).toBe('paused');
  });
});
