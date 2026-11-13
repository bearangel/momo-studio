// electron/tests/storage/task-runs-repo.test.ts
//
// task_runs repo CRUD + run 状态机集成测试（任务生命周期 v2，spec §5.2）。
// 覆盖：
//   - nextRunNo / insertRun 默认 runNo 递增；显式 runNo 透传
//   - getRun 全字段 camelCase 往返
//   - getActiveRun 只回活动态（running/waiting_human/submitted）；无活动为 null
//   - updateRun 状态变更走 canTransitionRun 校验（非法抛错含 from/to；终态拒改）
//   - listRuns（run_no ASC）/ countRuns
//   - 单活动 run 约束：同 task 第二个活动 run insert 抛 SqliteError
//     （部分唯一索引 idx_task_runs_active；服务层 Task 9 捕获转幂等，repo 不吞）
// 测试隔离：每个 case 用独立 tmp 目录 + closeDb + AP_USER_DATA_DIR 重置。
// FK 开启：workspaces / tasks 父行逐 case 种子。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask } from '../../src/main/storage/tasks/repo';
import {
  nextRunNo,
  insertRun,
  getRun,
  getActiveRun,
  updateRun,
  listRuns,
  countRuns,
} from '../../src/main/storage/tasks/runs-repo';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-task-runs-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // seed workspace（tasks 表有 FK 到 workspaces）
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 逐 case 种一个任务父行（task_runs.task_id FK → tasks.id），返回任务 id */
function seedTask(): string {
  return insertTask({ workspaceId: 'ws1', title: 'T', creatorUserId: '@owner:home' }).id;
}

describe('task_runs repo', () => {
  it('insertRun 默认 runNo 按 nextRunNo 递增（活动槽经终态闭合后继续递增）', () => {
    const taskId = seedTask();
    expect(nextRunNo(taskId)).toBe(1);
    const r1 = insertRun({ taskId, status: 'running', trigger: 'initial' });
    expect(r1.runNo).toBe(1);
    updateRun(r1.id, { status: 'failed', endedAt: 1 }); // 闭合 r1 释放活动槽
    const r2 = insertRun({ taskId, status: 'running', trigger: 'rework' });
    expect(r2.runNo).toBe(2);
    updateRun(r2.id, { status: 'cancelled', endedAt: 2 });
    expect(nextRunNo(taskId)).toBe(3);
    expect(nextRunNo('no-such-task')).toBe(1);
  });

  it('insertRun 显式 runNo 与 executionSessionId 透传', () => {
    const taskId = seedTask();
    const r = insertRun({
      taskId,
      status: 'running',
      trigger: 'manual',
      runNo: 7,
      executionSessionId: 'ses-x',
    });
    expect(r.runNo).toBe(7);
    expect(r.executionSessionId).toBe('ses-x');
  });

  it('getRun 全字段 camelCase 往返；不存在返回 null', () => {
    const taskId = seedTask();
    const r = insertRun({ taskId, status: 'running', trigger: 'quota_retry', executionSessionId: 's1' });
    const got = getRun(r.id);
    expect(got).not.toBeNull();
    expect(got).toMatchObject({
      id: r.id,
      taskId,
      runNo: 1,
      status: 'running',
      executionSessionId: 's1',
      trigger: 'quota_retry',
      endedAt: null,
      deliverableJson: null,
      rejectReason: null,
    });
    expect(got!.createdAt).toBeGreaterThan(0);
    expect(got!.updatedAt).toBe(got!.createdAt);
    expect(getRun('no-such')).toBeNull();
  });

  it('updateRun 状态变更 + deliverableJson / rejectReason / endedAt 落盘', () => {
    const taskId = seedTask();
    const r = insertRun({ taskId, status: 'running', trigger: 'initial' });
    updateRun(r.id, { status: 'submitted', deliverableJson: '{"text":"done"}' });
    expect(getRun(r.id)?.status).toBe('submitted');
    expect(getRun(r.id)?.deliverableJson).toBe('{"text":"done"}');
    // submitted → rejected（验收打回），打回原因 + 结束时间
    updateRun(r.id, { status: 'rejected', rejectReason: '质量不达标', endedAt: 123 });
    const after = getRun(r.id)!;
    expect(after.status).toBe('rejected');
    expect(after.rejectReason).toBe('质量不达标');
    expect(after.endedAt).toBe(123);
    // 未触碰的字段保值
    expect(after.deliverableJson).toBe('{"text":"done"}');
    expect(after.updatedAt).toBeGreaterThanOrEqual(after.createdAt);
  });

  it('updateRun 非法转换抛错且错误信息含 from/to', () => {
    const taskId = seedTask();
    const r = insertRun({ taskId, status: 'running', trigger: 'initial' });
    // running → accepted 非法：必须经 submitted 验收
    expect(() => updateRun(r.id, { status: 'accepted' })).toThrow(/running.*accepted/);
    expect(getRun(r.id)?.status).toBe('running'); // 校验拒绝后状态未被改写
  });

  it('updateRun 终态拒改（canTransitionRun 终态空集天然覆盖）', () => {
    const taskId = seedTask();
    const r = insertRun({ taskId, status: 'running', trigger: 'initial' });
    updateRun(r.id, { status: 'failed' });
    expect(() => updateRun(r.id, { status: 'running' })).toThrow(/failed.*running/);
    expect(getRun(r.id)?.status).toBe('failed');
  });

  it('getActiveRun 只回活动态；闭合后为 null；按 task 隔离', () => {
    const taskId = seedTask();
    expect(getActiveRun(taskId)).toBeNull();
    const r1 = insertRun({ taskId, status: 'running', trigger: 'initial' });
    expect(getActiveRun(taskId)?.id).toBe(r1.id);
    // 挂人仍是活动态
    updateRun(r1.id, { status: 'waiting_human' });
    expect(getActiveRun(taskId)?.id).toBe(r1.id);
    // 闭合后无活动 run
    updateRun(r1.id, { status: 'failed', endedAt: 1 });
    expect(getActiveRun(taskId)).toBeNull();
    // 不串任务
    const other = seedTask();
    const rOther = insertRun({ taskId: other, status: 'submitted', trigger: 'initial' });
    expect(getActiveRun(other)?.id).toBe(rOther.id);
    expect(getActiveRun(taskId)).toBeNull();
  });

  it('listRuns 按 run_no ASC；countRuns 计数（无行任务为 0）', () => {
    const taskId = seedTask();
    const r1 = insertRun({ taskId, status: 'running', trigger: 'initial' });
    updateRun(r1.id, { status: 'submitted' });
    updateRun(r1.id, { status: 'rejected', endedAt: 1, rejectReason: 'x' });
    const r2 = insertRun({ taskId, status: 'running', trigger: 'rework' });
    updateRun(r2.id, { status: 'submitted' });
    updateRun(r2.id, { status: 'accepted', endedAt: 2, deliverableJson: '{}' });
    expect(listRuns(taskId).map((r) => r.runNo)).toEqual([1, 2]);
    expect(countRuns(taskId)).toBe(2);
    expect(countRuns('no-such-task')).toBe(0);
  });

  it('并发活动冲突：同 task 第二个活动 run insert 抛 SqliteError（Task 9 捕获转幂等）', () => {
    const taskId = seedTask();
    insertRun({ taskId, status: 'running', trigger: 'initial' });
    expect(() => insertRun({ taskId, status: 'waiting_human', trigger: 'manual' })).toThrow();
    // 终态 run 不占活动槽：直接插终态行不抛（migration 081 专项测试同款语义）
    const t2 = seedTask();
    insertRun({ taskId: t2, status: 'failed', trigger: 'initial' });
    insertRun({ taskId: t2, status: 'running', trigger: 'manual' });
  });
});
