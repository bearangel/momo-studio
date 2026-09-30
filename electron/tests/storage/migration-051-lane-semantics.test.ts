// electron/tests/storage/migration-051-lane-semantics.test.ts
//
// 迁移 v051 专项测试（泳道语义重构，spec 2026-09-30 §4.5）：
//   1. UPDATE pending → draft（pending 退役；scheduled_at 原样保留，用户启动时
//      由 executor 闸门消费）；其余状态行不动
//   2. DROP COLUMN board_position（迁移 050 上线事故补救：050 的 up 中 DROP
//      语句丢失且已按 ADD-only 版本应用到存量库——本迁移对「已应用 050 的
//      存量库」与「全新库」统一愈合）
//
// 模式照抄 migration-050-task-scan-baseline 同款：内存库跑真实迁移到指定
// 版本（走 loadMigrations() 生产注册路径）→ 断言数据迁移与列增删。

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

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

/** 经 loadMigrations() 生产注册路径取 v51；未注册时给明确的红 */
function getMigration51Sql(): string {
  const m = loadMigrations().find((x) => x.version === 51);
  if (!m) throw new Error('migration v51 未注册进 MIGRATIONS 数组');
  return m.sql;
}

/** v50 态（050 ADD-only 已应用、board_position 列仍在）种子——模拟存量库 */
function seedV50(db: DB): void {
  applyUpTo(db, 50);
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id)
     VALUES ('ws1', '存量工作区', '/tmp/ws1', 'owner')`,
  ).run();
  const ins = db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, status, creator_user_id, scheduled_at, board_position, created_at, updated_at)
     VALUES (?, 'ws1', ?, ?, 'owner', ?, ?, 1, 1)`,
  );
  ins.run('T-901', '定时存量', 'pending', 1893456000000, 1.5);
  ins.run('T-902', '无目标存量', 'pending', null, null);
  ins.run('T-903', '已入队不动', 'assigned', null, null);
  ins.run('T-904', '草稿不动', 'draft', 1893456000000, null);
}

function tableColumns(db: DB): string[] {
  return (db.prepare("SELECT name FROM pragma_table_info('tasks')").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe('migration v051 泳道语义（pending→draft + DROP board_position）', () => {
  it('注册进 loadMigrations 且版本号为 51', () => {
    const m = loadMigrations().find((x) => x.version === 51);
    expect(m).toBeDefined();
    expect(m?.version).toBe(51);
  });

  it('存量库路径（050 ADD-only 后）：pending 行转 draft 且 scheduled_at 保留；其余状态不动', () => {
    const db = new Database(':memory:');
    seedV50(db);
    db.exec(getMigration51Sql());

    const row = (id: string): { status: string; scheduled_at: number | null } =>
      db.prepare('SELECT status, scheduled_at FROM tasks WHERE id = ?').get(id) as {
        status: string;
        scheduled_at: number | null;
      };
    expect(row('T-901').status).toBe('draft');
    expect(row('T-901').scheduled_at).toBe(1893456000000);
    expect(row('T-902').status).toBe('draft');
    expect(row('T-903').status).toBe('assigned');
    expect(row('T-904').status).toBe('draft');
    db.close();
  });

  it('board_position 列被删除；pinned_at（050 的 ADD）仍在', () => {
    const db = new Database(':memory:');
    seedV50(db);
    // 051 前存量事实：board_position 仍在（050 ADD-only）
    expect(tableColumns(db)).toContain('board_position');
    db.exec(getMigration51Sql());
    expect(tableColumns(db)).not.toContain('board_position');
    expect(tableColumns(db)).toContain('pinned_at');
    db.close();
  });

  it('全新库直建路径（v0 → 051 全链）：tasks 无 board_position 列', () => {
    const db = new Database(':memory:');
    applyUpTo(db, 51);
    expect(tableColumns(db)).not.toContain('board_position');
    expect(tableColumns(db)).toContain('pinned_at');
    db.close();
  });
});
