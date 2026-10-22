// electron/tests/storage/migration-068-session-group-color.test.ts
//
// 迁移 068 组色老库升级专项（预览 A rev2 批准定值，spec 2026-10-22 §4.4）：
// 构造 067 终态库 → 插入 workspace + 三个既有组（position/created_at 递增）
// → 应用 068 → 断言：存量组按 (position, created_at, id) 序 6 色轮转回填；
// 迁移后不带 color 的新 INSERT 组行为 NULL（color 列存在证明）。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

function applyUpTo(db: DB, version: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const mark = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
  for (const m of loadMigrations()) {
    if (m.version > version) break;
    db.exec(m.sql);
    mark.run(m.version);
  }
}

function migration68(): string {
  const m = loadMigrations().find((x) => x.version === 68);
  if (!m) throw new Error('migration 068 未注册进 MIGRATIONS 数组');
  return m.sql;
}

const WS = 'ws-a';

/** 067 终态夹具：一个 workspace + 三个既有组（position 1024/2048/3072，created_at 递增） */
function seed067(db: DB): void {
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(WS, 'ws', '', '/tmp/ws', 0, 'u1', '📁');
  const ins = db.prepare(
    'INSERT INTO session_groups (id, workspace_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  ins.run('g-1', WS, '甲', 1024, 100);
  ins.run('g-2', WS, '乙', 2048, 101);
  ins.run('g-3', WS, '丙', 3072, 102);
}

describe('migration 068：session_groups 组色列', () => {
  it('存量组按 (position, created_at, id) 序 6 色轮转回填（前三组依次 palette[0..2]）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, 67);
    seed067(db);
    db.exec(migration68());
    const color = (id: string) =>
      (db.prepare('SELECT color FROM session_groups WHERE id = ?').get(id) as { color: string | null }).color;
    expect(color('g-1')).toBe('#5E6AD2');
    expect(color('g-2')).toBe('#23835C');
    expect(color('g-3')).toBe('#B7791F');
    db.close();
  });

  it('迁移后新 INSERT 不带 color 的组行为 NULL（列存在证明）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, 67);
    seed067(db);
    db.exec(migration68());
    db.prepare(
      'INSERT INTO session_groups (id, workspace_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('g-new', WS, '新组', 4096, 103);
    const row = db.prepare('SELECT color FROM session_groups WHERE id = ?').get('g-new') as
      { color: string | null };
    expect(row.color).toBeNull();
    db.close();
  });
});
