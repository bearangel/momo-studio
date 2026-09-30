// electron/tests/storage/migration-050-task-pin.test.ts
//
// 迁移 v050 专项测试（看板顶置 + 手动排序退役）：pinned_at 增列 +
// board_position 删列。模式照抄 migration-049-task-scan-baseline.test.ts：
// 内存库跑真实迁移到 v49（指定迁移上限）→ 从 loadMigrations() 取 v50（走
// 生产注册路径）→ 断言列增删 + 既有数据无损。
//
// 断言清单：
//   1. v50 注册进 loadMigrations；升级前 pinned_at 不存在、board_position 存在
//   2. 升级后 pinned_at 存在（老行 NULL）、board_position 不存在
//   3. 既有任务行业务字段无损（title/status/created_at）
//   4. 全链升级（v0 → 050）后 tasks 无 board_position 列（新库直建路径）
//

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

const V49 = 49;

function applyUpTo(db: DB, version: number): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  const markApplied = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
  for (const m of loadMigrations()) {
    if (m.version > version) break;
    db.exec(m.sql);
    markApplied.run(m.version);
  }
}

/** 经 loadMigrations() 生产注册路径取 v50；未注册时给明确的红 */
function getMigration50Sql(): string {
  const m = loadMigrations().find((x) => x.version === 50);
  if (!m) throw new Error('migration v50 未注册进 MIGRATIONS 数组');
  return m.sql;
}

function seedV49(db: DB): void {
  applyUpTo(db, V49);
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id)
     VALUES ('ws-1', '老库工作区', '/tmp/ws-1', 'owner')`,
  ).run();
  // 一行带 board_position 的既有任务（模拟手动拖拽过的历史数据，DROP 后丢弃）
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, status, creator_user_id, created_at, updated_at, board_position)
     VALUES ('T-001', 'ws-1', '拖拽过位置的任务', 'draft', 'owner', 1000, 1000, 4096)`,
  ).run();
}

function taskColumns(db: DB): string[] {
  return (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe('migration v050：顶置字段 + 手动排序退役', () => {
  it('v50 注册进 loadMigrations；升级前 pinned_at 不存在、board_position 存在', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    seedV49(db);

    const cols = taskColumns(db);
    expect(cols).not.toContain('pinned_at');
    expect(cols).toContain('board_position');
    db.close();
  });

  it('升级后 pinned_at 存在（老行 NULL）、board_position 仍在（DROP 移交 051）、业务字段无损', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    seedV49(db);

    db.exec(getMigration50Sql());

    const cols = taskColumns(db);
    expect(cols).toContain('pinned_at');
    // 050 上线事故：up 中 tx-wrapped DROP 语句丢失且已按 ADD-only 应用到存量库；
    // DROP 收敛到 051（断言在 migration-051-lane-semantics.test.ts），050 如实
    // 断言 board_position 仍存在——防后人误以为 050 删过列
    expect(cols).toContain('board_position');

    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('T-001') as {
      title: string;
      status: string;
      created_at: number;
      pinned_at: number | null;
    };
    expect(row.title).toBe('拖拽过位置的任务');
    expect(row.status).toBe('draft');
    expect(row.created_at).toBe(1000);
    expect(row.pinned_at).toBeNull();
    db.close();
  });

  it('全链升级（v0 → 050）后 pinned_at 就位；board_position 的删除由 051 执行', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, 50);
    expect(taskColumns(db)).toContain('pinned_at');
    expect(taskColumns(db)).toContain('board_position');
    db.close();
  });
});
