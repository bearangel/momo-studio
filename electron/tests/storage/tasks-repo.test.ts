// electron/tests/storage/tasks-repo.test.ts
//
// tasks repo CRUD + 状态机集成测试。
// 测试覆盖：
//   - insertTask（自动 id / 默认 status / 默认 priority / 默认 toolCallsUsed）
//   - updateTask（部分字段 patch）
//   - transitionTaskStatus（合法转换 + 自动设 startedAt/completedAt；非法抛错；终态不可转）
//   - listTasks（workspace / status / status[] 过滤）
//   - findNextAssignedTask（priority DESC + scheduled_at ASC + 排除未到 scheduled_at）
//
// 测试隔离：每个 case 用独立 tmp 目录 + closeDb + AP_USER_DATA_DIR 重置。
// tasks 表有 FK 到 workspaces(id)，故每个 case 都 seed 一个 ws1 工作空间。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertTask,
  updateTask,
  transitionTaskStatus,
  getTask,
  listTasks,
  findNextAssignedTask,
} from '../../src/main/storage/tasks/repo';
import { TASK_MENTION_REGEX } from '../../src/main/task/conflict-detector';

const tmpRoot = path.join(os.tmpdir(), `ap-task-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // seed workspace（tasks 表有 FK 到 workspaces）
  getDb().prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`,
  ).run('ws1', 'Test', '/tmp', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('tasks repo', () => {
  it('insertTask 自动 id 为 T-xxx 短序号（#T mention 可解析）+ 默认 status=draft', () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    // T-后接 ≥3 位数字（零填充）—— 与 conflict-detector.ts 的 TASK_MENTION_REGEX /#T-\d+/ 假设对齐
    expect(t.id).toMatch(/^T-\d{3,}$/);
    expect(t.status).toBe('draft');
    expect(t.priority).toBe(0);
    expect(t.toolCallsUsed).toBe(0);
    expect(t.createdAt).toBeGreaterThan(0);
    expect(t.updatedAt).toBe(t.createdAt);
  });

  it('insertTask 序号单调递增（fresh DB → T-001 / T-002 / T-003 风格）', () => {
    const t1 = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    const t2 = insertTask({
      workspaceId: 'ws1',
      title: 'T2',
      creatorUserId: '@owner:home',
    });
    const t3 = insertTask({
      workspaceId: 'ws1',
      title: 'T3',
      creatorUserId: '@owner:home',
    });
    expect(t1.id).toBe('T-001');
    expect(t2.id).toBe('T-002');
    expect(t3.id).toBe('T-003');
    // 序号随新增单调递增
    const n1 = Number(t1.id.slice(2));
    const n3 = Number(t3.id.slice(2));
    expect(n3).toBe(n1 + 2);
  });

  it('insertTask 显式传入 id 时透传（不被自动编号覆盖）', () => {
    const t = insertTask({
      id: 'T-100',
      workspaceId: 'ws1',
      title: 'explicit',
      creatorUserId: '@owner:home',
    });
    expect(t.id).toBe('T-100');
    // 后续自动编号不应受显式 id 干扰：仍从最大已有序号+1 起
    const t2 = insertTask({
      workspaceId: 'ws1',
      title: 'after',
      creatorUserId: '@owner:home',
    });
    expect(t2.id).toBe('T-101');
  });

  it('insertTask 序号跳过非 T- 前缀 id（兼容 legacy UUID + T-005 混存）', () => {
    // 手工 seed 一条 UUID 行（模拟老库迁移或外部数据）
    getDb()
      .prepare(
        `INSERT INTO tasks (id, workspace_id, title, description, status, creator_user_id,
                            priority, tool_calls_used, created_at, updated_at)
         VALUES (?, ?, ?, '', 'draft', ?, 0, 0, ?, ?)`,
      )
      .run('legacy-uuid-xxxx', 'ws1', 'legacy', '@owner:home', Date.now(), Date.now());
    // 再 seed 一条 T-005
    const seeded = insertTask({
      id: 'T-005',
      workspaceId: 'ws1',
      title: 'seeded',
      creatorUserId: '@owner:home',
    });
    expect(seeded.id).toBe('T-005');
    // 自动编号应跳过 UUID 行、基于 T-005 产生 T-006
    const next = insertTask({
      workspaceId: 'ws1',
      title: 'after-legacy',
      creatorUserId: '@owner:home',
    });
    expect(next.id).toBe('T-006');
  });

  it('insertTask 生成的 id 在 #T mention 正则下可被解析（端到端配对）', () => {
    // 权威正则从 conflict-detector.ts 导入；repo 生成的 id 必须能被该正则解析。
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'mentionable',
      creatorUserId: '@owner:home',
    });
    // 模拟消息正文包含任务 mention
    const body = `请参考 #${t.id} 的最新进展`;
    const matches = Array.from(body.matchAll(TASK_MENTION_REGEX)).map((m) => m[1]);
    expect(matches).toContain(t.id);
  });

  it('updateTask 部分更新', () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    updateTask(t.id, { title: 'T1-updated', priority: 5 });
    const got = getTask(t.id);
    expect(got?.title).toBe('T1-updated');
    expect(got?.priority).toBe(5);
  });

  it('transitionTaskStatus 合法转换成功 + 自动设 startedAt/completedAt', () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'pending');
    transitionTaskStatus(t.id, 'assigned');
    const inProgress = transitionTaskStatus(t.id, 'in_progress', {
      executionSessionId: 'r1',
      startedAt: Date.now(),
    });
    expect(inProgress.status).toBe('in_progress');
    expect(inProgress.executionSessionId).toBe('r1');
    expect(inProgress.startedAt).toBeGreaterThan(0);

    const completed = transitionTaskStatus(t.id, 'completed', {
      completedAt: Date.now(),
    });
    expect(completed.completedAt).toBeGreaterThan(0);
  });

  it('transitionTaskStatus 非法转换抛错', () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    expect(() => transitionTaskStatus(t.id, 'in_progress')).toThrow(/非法/);
  });

  it('transitionTaskStatus 到终态后不可再转', () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'cancelled');
    expect(() => transitionTaskStatus(t.id, 'in_progress')).toThrow(/非法/);
  });

  it('listTasks 按 workspace 过滤', () => {
    insertTask({ workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home' });
    insertTask({ workspaceId: 'ws1', title: 'T2', creatorUserId: '@owner:home' });
    const list = listTasks({ workspaceId: 'ws1' });
    expect(list.length).toBe(2);
  });

  it('listTasks 按 status 过滤（单个 + 数组）', () => {
    const t1 = insertTask({ workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home' });
    insertTask({ workspaceId: 'ws1', title: 'T2', creatorUserId: '@owner:home' });
    transitionTaskStatus(t1.id, 'pending');
    expect(listTasks({ workspaceId: 'ws1', status: 'pending' }).length).toBe(1);
    expect(listTasks({ workspaceId: 'ws1', status: ['pending', 'draft'] }).length).toBe(2);
  });

  it('findNextAssignedTask 按 priority DESC + created_at ASC（priority 相同）', () => {
    const t1 = insertTask({
      workspaceId: 'ws1',
      title: 'low',
      creatorUserId: '@owner:home',
      priority: 1,
      assigneeAgentId: '@agent:home',
    });
    const t2 = insertTask({
      workspaceId: 'ws1',
      title: 'high',
      creatorUserId: '@owner:home',
      priority: 10,
      assigneeAgentId: '@agent:home',
    });
    const t3 = insertTask({
      workspaceId: 'ws1',
      title: 'high-2',
      creatorUserId: '@owner:home',
      priority: 10,
      assigneeAgentId: '@agent:home',
    });
    transitionTaskStatus(t1.id, 'pending');
    transitionTaskStatus(t1.id, 'assigned');
    transitionTaskStatus(t2.id, 'pending');
    transitionTaskStatus(t2.id, 'assigned');
    transitionTaskStatus(t3.id, 'pending');
    transitionTaskStatus(t3.id, 'assigned');

    const next = findNextAssignedTask('@agent:home', Date.now());
    // priority 10 > 1，所以 t1 不该被选
    expect(next?.id).not.toBe(t1.id);
    // t2 和 t3 priority 相同，t2 创建早
    expect(next?.id).toBe(t2.id);
  });

  it('findNextAssignedTask 排除未到 scheduled_at 的任务', () => {
    const future = Date.now() + 60_000;
    const t1 = insertTask({
      workspaceId: 'ws1',
      title: 'future',
      creatorUserId: '@owner:home',
      scheduledAt: future,
      assigneeAgentId: '@agent:home',
    });
    transitionTaskStatus(t1.id, 'pending');
    transitionTaskStatus(t1.id, 'assigned');
    const next = findNextAssignedTask('@agent:home', Date.now());
    expect(next).toBeNull();
  });
});