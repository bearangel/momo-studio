// electron/tests/task/scheduler.test.ts
//
// TaskScheduler 测试（D 子系统 D6）。
//
// 测试覆盖（3 个用例）：
//   1. 扫描 pending + scheduled_at 已到 → 转 assigned + 触发 scanPickup
//   2. scheduled_at 未到 → 不转、不触发
//   3. start/stop：定时器正确启停（间隔 50ms，120ms 后 stop 不抛错）
//
// 测试隔离：tmp 目录 + closeDb + AP_USER_DATA_DIR 重置。
// tasks 表 FK 仅依赖 workspaces，所以测试 seed 一个 ws 即可。
//
// 注意：insertTask 默认 status='draft'，本测试需要 pending 状态，
// 故在 insert 后直接 UPDATE 字段到 'pending'——不走 transitionTaskStatus，
// 因为 draft → pending 需要走转换器（合法，但本测试关注 scheduler 而非状态机）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, listTasks } from '../../src/main/storage/tasks/repo';
import { TaskScheduler } from '../../src/main/task/scheduler';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-sched-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // seed workspace（tasks 表 FK 要求）
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`,
    )
    .run('ws1', 'Test', '/tmp', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('TaskScheduler', () => {
  it('扫描 pending 任务 + scheduled_at 已到 → 转 assigned + 触发 scanPickup', () => {
    const past = Date.now() - 1000;
    insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst1',
      scheduledAt: past,
    });
    // 直接改 status 为 pending（insertTask 默认 draft；scheduler 只看 pending → assigned）
    const db = getDb();
    db.prepare('UPDATE tasks SET status = ? WHERE title = ?').run('pending', 'T1');

    const scanPickup = vi.fn().mockResolvedValue(true);
    const sched = new TaskScheduler({ scanPickup, intervalMs: 1000 });
    sched.checkOnce();

    const updated = listTasks({ workspaceId: 'ws1' })[0];
    expect(updated.status).toBe('assigned');
    expect(scanPickup).toHaveBeenCalledWith('inst1');
  });

  it('scheduled_at 未到 → 不转 + 不触发 scanPickup', () => {
    const future = Date.now() + 60_000;
    insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst1',
      scheduledAt: future,
    });
    const db = getDb();
    db.prepare('UPDATE tasks SET status = ? WHERE title = ?').run('pending', 'T1');

    const scanPickup = vi.fn();
    const sched = new TaskScheduler({ scanPickup, intervalMs: 1000 });
    sched.checkOnce();

    const updated = listTasks({ workspaceId: 'ws1' })[0];
    expect(updated.status).toBe('pending');
    expect(scanPickup).not.toHaveBeenCalled();
  });

  it('start / stop：定时器正确启停，不抛错', () =>
    new Promise<void>((resolve) => {
      const sched = new TaskScheduler({ scanPickup: vi.fn(), intervalMs: 50 });
      sched.start();
      // 等待至少一次 tick，然后 stop；120ms > 50ms*2，确保 setInterval 至少触发一次
      setTimeout(() => {
        sched.stop();
        resolve();
      }, 120);
    }));
});