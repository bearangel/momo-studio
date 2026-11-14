// electron/tests/storage/task-lifecycle-migration-082.test.ts
//
// 迁移 082 专项（任务生命周期 v2 回填，spec 2026-11-13 §5.5）。锁什么：
//   - 存量 in_progress/paused 任务补 run #1 + current_run_id 指向活动 run；
//     终态任务（completed 等）不补
//   - origin='dispatch' 簿记行回填 auto_accept=1；普通 user 行不动
//   - 幂等：重复执行不产生第二个 run（NOT EXISTS 守卫）
// 种子方式沿用同目录既有 migration 测试模式：内存库 applyUpTo 81（081 终态
// 结构，082 注册后截断于 81 不受影响）直接 INSERT 存量形态行，再手动
// db.exec(m082.up) 断言回填结果。foreign_keys=ON —— 先插 workspaces 父行。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';
import * as m082 from '../../src/main/storage/migrations/082_task_lifecycle_backfill';

function applyUpTo(db: DB, version: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const mark = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
  for (const mig of loadMigrations()) {
    if (mig.version > version) break;
    db.exec(mig.sql);
    mark.run(mig.version);
  }
}

/** 081 终态库（未跑 082）：内存库 + FK 父行种子（workspaces 'ws'），返回原始句柄供手动 exec。 */
function setupTestDbRaw(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyUpTo(db, 81);
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('ws', 'ws', '', '/tmp/ws', 0, 'u1', '📁');
  return db;
}

describe('migration 082 backfill', () => {
  it('082 注册为顺延迁移（末位哨兵已随 083 追加移交——070→080→082 先例）', () => {
    const versions = loadMigrations().map((m) => m.version);
    expect(versions).toContain(81);
    expect(versions).toContain(82);
    // 版本唯一性（重复注册会让 runner 静默跳过第二条，属契约破坏）
    expect(new Set(versions).size).toBe(versions.length);
    // 版本有序（runner 依赖升序执行）
    const sorted = [...versions].sort((a, b) => a - b);
    expect(versions).toEqual(sorted);
  });

  it('存量 in_progress 补 run #1 + current_run_id；终态任务不补', () => {
    const db = setupTestDbRaw();
    const ins = db.prepare(`INSERT INTO tasks (id, workspace_id, title, status, creator_user_id, created_at, updated_at, started_at, origin)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    ins.run('T-act', 'ws', 'a', 'in_progress', 'u', 100, 100, 120, 'user');
    ins.run('T-done', 'ws', 'b', 'completed', 'u', 100, 100, 120, 'user');
    db.exec(m082.up);
    const run = db.prepare(`SELECT * FROM task_runs WHERE task_id='T-act'`).get() as { run_no: number; status: string; trigger: string };
    expect(run.run_no).toBe(1);
    expect(run.status).toBe('running');
    expect(run.trigger).toBe('initial');
    expect(db.prepare(`SELECT current_run_id FROM tasks WHERE id='T-act'`).get()).toEqual(
      db.prepare(`SELECT id AS current_run_id FROM task_runs WHERE task_id='T-act'`).get());
    expect(db.prepare(`SELECT COUNT(*) c FROM task_runs WHERE task_id='T-done'`).get()).toMatchObject({ c: 0 });
  });

  it('dispatch 簿记行回填 auto_accept=1；普通行不动', () => {
    const db = setupTestDbRaw();
    db.prepare(`INSERT INTO tasks (id, workspace_id, title, status, creator_user_id, created_at, updated_at, origin)
      VALUES ('T-d','ws','d','in_progress','agent:x',0,0,'dispatch'),('T-u','ws','u','in_progress','u',0,0,'user')`).run();
    db.exec(m082.up);
    expect(db.prepare(`SELECT auto_accept FROM tasks WHERE id='T-d'`).get()).toMatchObject({ auto_accept: 1 });
    expect(db.prepare(`SELECT auto_accept FROM tasks WHERE id='T-u'`).get()).toMatchObject({ auto_accept: 0 });
  });

  it('幂等：重复执行不产生第二个 run', () => {
    const db = setupTestDbRaw();
    db.prepare(`INSERT INTO tasks (id, workspace_id, title, status, creator_user_id, created_at, updated_at, origin)
      VALUES ('T-1','ws','t','in_progress','u',0,0,'user')`).run();
    db.exec(m082.up);
    db.exec(m082.up);
    expect(db.prepare(`SELECT COUNT(*) c FROM task_runs WHERE task_id='T-1'`).get()).toMatchObject({ c: 1 });
  });
});
