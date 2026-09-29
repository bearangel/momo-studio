// electron/tests/storage/migration-049-task-scan-baseline.test.ts
//
// 迁移 v049 专项测试（未入账误归因根治）：任务起点基线两表建表。
// 模式照抄 migration-047-kanban-groups.test.ts：内存库跑真实迁移到 v48
// （指定迁移上限）→ 从 loadMigrations() 取 v49（走生产注册路径而非直接
// import 模块——注册缺失应在第一时间红）→ 断言两表结构 + PK 约束。
//
// 断言清单：
//   1. v49 注册进 loadMigrations；升级前两表不存在（防既有残留假绿）
//   2. task_scan_baseline 四列结构（workspace_id/task_id/captured_at/degraded）
//   3. task_scan_baseline_path 三列结构 + content_hash 可 NULL
//   4. 复合主键约束生效：meta 表 (ws, task) 唯一；path 表 (ws, task, path) 唯一
//

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

const V48 = 48;

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

/** 经 loadMigrations() 生产注册路径取 v49；未注册时给明确的红 */
function getMigration49Sql(): string {
  const m = loadMigrations().find((x) => x.version === 49);
  if (!m) throw new Error('migration v49 未注册进 MIGRATIONS 数组');
  return m.sql;
}

function seedV48(db: DB): void {
  applyUpTo(db, V48);
}

describe('migration v049：任务起点基线两表', () => {
  it('v49 注册进 loadMigrations；升级前两表不存在（防既有残留假绿）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    seedV48(db);

    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_scan_baseline'")
        .get(),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='task_scan_baseline_path'",
        )
        .get(),
    ).toBeUndefined();
    db.close();
  });

  it('task_scan_baseline 四列结构（degraded 默认 0）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    seedV48(db);
    db.exec(getMigration49Sql());

    const cols = db.prepare('PRAGMA table_info(task_scan_baseline)').all() as Array<{
      name: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }>;
    expect(cols.map((c) => ({ name: c.name, notnull: c.notnull, pk: c.pk }))).toEqual([
      { name: 'workspace_id', notnull: 1, pk: 1 },
      { name: 'task_id', notnull: 1, pk: 2 },
      { name: 'captured_at', notnull: 1, pk: 0 },
      { name: 'degraded', notnull: 1, pk: 0 },
    ]);
    // degraded 列默认 0（非降级基线）
    expect(cols.find((c) => c.name === 'degraded')?.dflt_value).toBe('0');
    db.close();
  });

  it('task_scan_baseline_path 三列结构 + content_hash 可 NULL（捕获时不可读）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    seedV48(db);
    db.exec(getMigration49Sql());

    const cols = db.prepare('PRAGMA table_info(task_scan_baseline_path)').all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    expect(cols.map((c) => ({ name: c.name, notnull: c.notnull, pk: c.pk }))).toEqual([
      { name: 'workspace_id', notnull: 1, pk: 1 },
      { name: 'task_id', notnull: 1, pk: 2 },
      { name: 'path', notnull: 1, pk: 3 },
      { name: 'content_hash', notnull: 0, pk: 0 },
    ]);

    // content_hash 可 NULL 落行（= 捕获时文件不可读的语义载体）
    db.prepare(
      `INSERT INTO task_scan_baseline_path (workspace_id, task_id, path, content_hash)
       VALUES ('ws-1', 'T-1', 'gone.txt', NULL)`,
    ).run();
    const row = db
      .prepare(`SELECT content_hash FROM task_scan_baseline_path WHERE workspace_id='ws-1'`)
      .get() as { content_hash: string | null };
    expect(row.content_hash).toBeNull();
    db.close();
  });

  it('复合主键唯一约束：meta 表 (ws, task) 重复拒绝；path 表 (ws, task, path) 重复拒绝', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    seedV48(db);
    db.exec(getMigration49Sql());

    db.prepare(
      `INSERT INTO task_scan_baseline (workspace_id, task_id, captured_at, degraded)
       VALUES ('ws-1', 'T-1', 1000, 0)`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO task_scan_baseline (workspace_id, task_id, captured_at, degraded)
         VALUES ('ws-1', 'T-1', 2000, 0)`,
      ).run(),
    ).toThrow();

    db.prepare(
      `INSERT INTO task_scan_baseline_path (workspace_id, task_id, path, content_hash)
       VALUES ('ws-1', 'T-1', 'a.txt', 'h1')`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO task_scan_baseline_path (workspace_id, task_id, path, content_hash)
         VALUES ('ws-1', 'T-1', 'a.txt', 'h2')`,
      ).run(),
    ).toThrow();
    // 同任务不同 path、同 path 不同任务均可写（PK 三列组合键）
    db.prepare(
      `INSERT INTO task_scan_baseline_path (workspace_id, task_id, path, content_hash)
       VALUES ('ws-1', 'T-1', 'b.txt', 'h3')`,
    ).run();
    db.prepare(
      `INSERT INTO task_scan_baseline_path (workspace_id, task_id, path, content_hash)
       VALUES ('ws-1', 'T-2', 'a.txt', 'h4')`,
    ).run();
    db.close();
  });
});
