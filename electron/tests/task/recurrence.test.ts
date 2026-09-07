// electron/tests/task/recurrence.test.ts
//
// nextRun 纯函数 + spawnNextInstanceIfRecurring 测试。
// 时间全部注入固定值，不依赖真实时钟（防 flaky）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, listTasks } from '../../src/main/storage/tasks/repo';
import { nextRun, spawnNextInstanceIfRecurring } from '../../src/main/task/recurrence';

const tmpRoot = path.join(os.tmpdir(), `ap-rec-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('nextRun 纯函数', () => {
  // 2026-09-07 08:30 (周一) UTC+0 本地时区无关——用 Date 构造
  const base = new Date(2026, 8, 7, 8, 30).getTime();

  it('every:30m → 完成时间 + 30 分钟', () => {
    expect(nextRun(base, 'every:30m')).toBe(base + 30 * 60_000);
  });
  it('every:2h / every:1d 单位换算', () => {
    expect(nextRun(base, 'every:2h')).toBe(base + 2 * 3_600_000);
    expect(nextRun(base, 'every:1d')).toBe(base + 86_400_000);
  });
  it('daily@09:00 → 当天 09:00（08:30 未过）', () => {
    expect(nextRun(base, 'daily@09:00')).toBe(new Date(2026, 8, 7, 9, 0).getTime());
  });
  it('daily@09:00 → 已过 09:00 取明天', () => {
    const late = new Date(2026, 8, 7, 9, 30).getTime();
    expect(nextRun(late, 'daily@09:00')).toBe(new Date(2026, 8, 8, 9, 0).getTime());
  });
  it('weekly@1,09:00 → 周一 08:30 取当天；周一 09:30 取下周一', () => {
    expect(nextRun(base, 'weekly@1,09:00')).toBe(new Date(2026, 8, 7, 9, 0).getTime());
    const late = new Date(2026, 8, 7, 9, 30).getTime();
    expect(nextRun(late, 'weekly@1,09:00')).toBe(new Date(2026, 8, 14, 9, 0).getTime());
  });
  it('weekly@3,09:00 → 周一取本周三', () => {
    expect(nextRun(base, 'weekly@3,09:00')).toBe(new Date(2026, 8, 9, 9, 0).getTime());
  });
  it('非法规则 / 非法数值 → null', () => {
    expect(nextRun(base, 'cron:0 9 * * *')).toBeNull();
    expect(nextRun(base, 'every:0m')).toBeNull();
    expect(nextRun(base, 'daily@25:00')).toBeNull();
    expect(nextRun(base, '')).toBeNull();
  });
});

describe('spawnNextInstanceIfRecurring', () => {
  it('completed + every:30m → 生成 pending 下一实例（字段复制 + scheduledAt + 母链）', () => {
    const now = Date.now();
    insertTask({
      workspaceId: 'ws1', title: '日报', description: '写日报', creatorUserId: 'owner',
      priority: 5, assigneeAgentId: 'inst1', recurrenceRule: 'every:30m',
      status: 'in_progress', startedAt: now - 60_000,
    });
    getDb().prepare(
      `UPDATE tasks SET status='completed', completed_at=? WHERE id='T-001'`,
    ).run(now);
    // completed 由 updateTask 裸写（此处测 spawn，不测状态机）

    spawnNextInstanceIfRecurring('T-001');

    const next = listTasks({ workspaceId: 'ws1' }).find((t) => t.id !== 'T-001')!;
    expect(next.status).toBe('pending');
    expect(next.recurrenceParentId).toBe('T-001');
    expect(next.recurrenceRule).toBe('every:30m');
    expect(next.assigneeAgentId).toBe('inst1');
    expect(next.scheduledAt).toBe(now + 30 * 60_000);
    expect(next.title).toBe('日报');
    expect(next.deadlineAt).toBeNull(); // deadline 不复制（spec §7.2）
  });

  it('failed / 无规则 / 非 completed → 不生成', () => {
    insertTask({ workspaceId: 'ws1', title: 'A', creatorUserId: 'owner', recurrenceRule: 'every:1h', status: 'failed' });
    insertTask({ workspaceId: 'ws1', title: 'B', creatorUserId: 'owner', status: 'completed' });
    spawnNextInstanceIfRecurring('T-001');
    spawnNextInstanceIfRecurring('T-002');
    expect(listTasks({ workspaceId: 'ws1' })).toHaveLength(2);
  });
});
