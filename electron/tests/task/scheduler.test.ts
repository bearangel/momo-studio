// electron/tests/task/scheduler.test.ts
//
// TaskScheduler 测试（D 子系统 D6 → 2026-09-30 泳道语义重构 §4.3）。
//
// 测试覆盖（4 个用例）：
//   1. 到点 assigned 存在 → 触发一次 scanPickup（due-wakeup），零转态零广播
//   2. 只有未来时间的 assigned → 不触发
//   3. draft 带过去时间（未启动）→ 不触发（草稿永不入队）
//   4. start/stop：定时器正确启停（间隔 50ms，120ms 后 stop 不抛错）
//
// 测试隔离：tmp 目录 + closeDb + AP_USER_DATA_DIR 重置。
// tasks 表 FK 仅依赖 workspaces，所以测试 seed 一个 ws 即可。
//
// 注意：insertTask 默认 status='draft'，需要指定状态时在 insert 后直接
// UPDATE——不走 transitionTaskStatus（本测试关注 scheduler 而非状态机）。
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

/** 种子：insert 后直改 status（insertTask 默认 draft） */
function seedTask(title: string, status: string, scheduledAt: number | null): void {
  insertTask({
    workspaceId: 'ws1',
    title,
    creatorUserId: '@owner:home',
    assigneeAgentId: 'inst1',
    scheduledAt,
  });
  getDb().prepare('UPDATE tasks SET status = ? WHERE title = ?').run(status, title);
}

describe('TaskScheduler due-wakeup（2026-09-30 §4.3：pending 升级扫描退役）', () => {
  it('到点 assigned 存在 → 触发一次 scanPickup，零转态', () => {
    seedTask('T1', 'assigned', Date.now() - 1000);
    const scanPickup = vi.fn().mockResolvedValue(true);
    new TaskScheduler({ scanPickup, intervalMs: 1000 }).checkOnce();

    expect(scanPickup).toHaveBeenCalledTimes(1);
    expect(scanPickup).toHaveBeenCalledWith('');
    // 零转态：转态是 executor 放行链的职责，scheduler 只做唤醒
    expect(listTasks({ workspaceId: 'ws1' })[0]!.status).toBe('assigned');
  });

  it('session_queued 到点 → 同样触发（车道排队并入唤醒）', () => {
    seedTask('T1', 'session_queued', Date.now() - 1000);
    const scanPickup = vi.fn().mockResolvedValue(true);
    new TaskScheduler({ scanPickup, intervalMs: 1000 }).checkOnce();
    expect(scanPickup).toHaveBeenCalledTimes(1);
  });

  it('只有未来时间的 assigned → 不触发', () => {
    seedTask('T1', 'assigned', Date.now() + 60_000);
    const scanPickup = vi.fn();
    new TaskScheduler({ scanPickup, intervalMs: 1000 }).checkOnce();
    expect(scanPickup).not.toHaveBeenCalled();
    expect(listTasks({ workspaceId: 'ws1' })[0]!.status).toBe('assigned');
  });

  it('draft 带过去时间（未启动）→ 不触发（草稿永不入队）', () => {
    seedTask('T1', 'draft', Date.now() - 1000);
    const scanPickup = vi.fn();
    new TaskScheduler({ scanPickup, intervalMs: 1000 }).checkOnce();
    expect(scanPickup).not.toHaveBeenCalled();
    expect(listTasks({ workspaceId: 'ws1' })[0]!.status).toBe('draft');
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