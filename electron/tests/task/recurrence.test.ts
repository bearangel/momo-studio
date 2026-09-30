// electron/tests/task/recurrence.test.ts
//
// nextRun 纯函数 + spawnNextInstanceIfRecurring 测试。
// 时间全部注入固定值，不依赖真实时钟（防 flaky）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  // 泳道语义重构（2026-09-30 §4.3）：续期实例落 assigned（建即入队），下次
  // 时间由 executor 闸门管——旧「pending 待 scheduler 升级」中转退役
  it('completed + every:30m → 生成 assigned 下一实例（字段复制 + scheduledAt + 母链）', () => {
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
    expect(next.status).toBe('assigned');
    expect(next.recurrenceParentId).toBe('T-001');
    expect(next.recurrenceRule).toBe('every:30m');
    expect(next.assigneeAgentId).toBe('inst1');
    expect(next.scheduledAt).toBe(now + 30 * 60_000);
    expect(next.title).toBe('日报');
    expect(next.deadlineAt).toBeNull(); // deadline 不复制（spec §7.2）
  });

  it('续期实例未来 scheduledAt → executor 闸门不捞（等下个周期自动跑）', async () => {
    const now = Date.now();
    insertTask({
      workspaceId: 'ws1', title: '每时', creatorUserId: 'owner',
      assigneeAgentId: 'inst1', recurrenceRule: 'every:1h',
      status: 'in_progress', startedAt: now - 60_000,
    });
    getDb().prepare(
      `UPDATE tasks SET status='completed', completed_at=? WHERE id='T-001'`,
    ).run(now);
    spawnNextInstanceIfRecurring('T-001');

    // executor 评估一轮：未来时间（now+1h）被闸门拦下，留排队中
    const { TaskExecutor } = await import('../../src/main/task/executor');
    const ex = new TaskExecutor();
    ex.init({ sendKickoff: vi.fn().mockResolvedValue(undefined), getGlobalMax: () => 3 });
    await ex.admitOnce();
    const next = listTasks({ workspaceId: 'ws1' }).find((t) => t.id !== 'T-001')!;
    expect(next.status).toBe('assigned'); // 排队中等到点
  });

  it('failed / 无规则 / 非 completed → 不生成', () => {
    insertTask({ workspaceId: 'ws1', title: 'A', creatorUserId: 'owner', recurrenceRule: 'every:1h', status: 'failed' });
    insertTask({ workspaceId: 'ws1', title: 'B', creatorUserId: 'owner', status: 'completed' });
    spawnNextInstanceIfRecurring('T-001');
    spawnNextInstanceIfRecurring('T-002');
    expect(listTasks({ workspaceId: 'ws1' })).toHaveLength(2);
  });
});
