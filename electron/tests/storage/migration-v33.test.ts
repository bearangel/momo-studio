// electron/tests/storage/migration-v33.test.ts
//
// 迁移 v33 测试：变更账本 journal_entries 表（v2.5 变更账本与撤销）。
//
//   1. v33 建表：12 列结构 + nullability + 主键正确；**无 message_id 列**
//      （计划精化：消息行流结束才落库，记账时 message_id 不存在——归组键统一
//      stream_session_id；spec §5.2 的 message_id 列与对应索引已取消）
//   2. 两索引存在：idx_journal_task(workspace_id, task_id) +
//      idx_journal_stream(workspace_id, stream_session_id)
//   3. 幂等：重复执行 up SQL 不炸、索引不重复
//
// 模式照抄 migration-v32.test.ts：内存库跑真实迁移到 v32 → 从 loadMigrations()
// 取 v33（走生产注册路径而非直接 import 模块——注册缺失应在第一时间红）。

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

const V32 = 32;

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

/** 经 loadMigrations() 生产注册路径取 v33；未注册时给明确的红 */
function getMigration33Sql(): string {
  const m = loadMigrations().find((x) => x.version === 33);
  if (!m) throw new Error('migration v33 未注册进 MIGRATIONS 数组');
  return m.sql;
}

interface ColumnBrief {
  name: string;
  notnull: number;
  pk: number;
}

function tableColumns(db: DB, table: string): ColumnBrief[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  return rows.map((r) => ({ name: r.name, notnull: r.notnull, pk: r.pk }));
}

/** 取索引定义并压缩全部空白（对格式化不敏感，仍锁定 表名+覆盖列） */
function indexSql(db: DB, name: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?")
    .get(name) as { sql: string } | undefined;
  if (!row) throw new Error(`索引 ${name} 不存在`);
  return row.sql.replace(/\s+/g, '');
}

describe('migration v33：journal_entries 变更账本表', () => {
  it('v33 注册进 loadMigrations，应用后建表；v32 前表不存在', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V32);
    // 前置：v33 之前 journal_entries 不存在（防既有残留假绿）
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='journal_entries'")
        .get(),
    ).toBeUndefined();

    db.exec(getMigration33Sql());

    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='journal_entries'")
        .get(),
    ).toEqual({ name: 'journal_entries' });
    db.close();
  });

  it('列结构：12 列按序 + nullability/主键正确 + 无 message_id（计划精化）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V32);
    db.exec(getMigration33Sql());

    // notnull：1=NOT NULL，0=可空。可空列与 TS JournalEntry 的 `| null` 字段一一对应
    // （task_id 快速会话可空 / session_id 边界可空 / before_hash(create 前)/
    //  after_hash(delete 后)/old_path(非 rename) 语义可空）。
    expect(tableColumns(db, 'journal_entries')).toEqual([
      { name: 'id', notnull: 1, pk: 1 },
      { name: 'workspace_id', notnull: 1, pk: 0 },
      { name: 'task_id', notnull: 0, pk: 0 },
      { name: 'session_id', notnull: 0, pk: 0 },
      { name: 'stream_session_id', notnull: 1, pk: 0 },
      { name: 'tool_name', notnull: 1, pk: 0 },
      { name: 'path', notnull: 1, pk: 0 },
      { name: 'op', notnull: 1, pk: 0 },
      { name: 'before_hash', notnull: 0, pk: 0 },
      { name: 'after_hash', notnull: 0, pk: 0 },
      { name: 'old_path', notnull: 0, pk: 0 },
      { name: 'created_at', notnull: 1, pk: 0 },
    ]);

    // 计划精化回归锁：绝不出现 message_id 列
    const cols = tableColumns(db, 'journal_entries');
    expect(cols.some((c) => c.name === 'message_id')).toBe(false);
    db.close();
  });

  it('两索引存在且覆盖列正确（task 组 / stream 组）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V32);
    db.exec(getMigration33Sql());

    // 空白已全压缩：期望串内不留空格
    expect(indexSql(db, 'idx_journal_task')).toContain('ONjournal_entries(workspace_id,task_id)');
    expect(indexSql(db, 'idx_journal_stream')).toContain(
      'ONjournal_entries(workspace_id,stream_session_id)',
    );
    db.close();
  });

  it('幂等：重复执行 up 不炸、索引不重复', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V32);
    const sql = getMigration33Sql();

    db.exec(sql);
    expect(() => db.exec(sql)).not.toThrow();

    const count = (name: string): number =>
      (
        db
          .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name = ?")
          .get(name) as { c: number }
      ).c;
    expect(count('idx_journal_task')).toBe(1);
    expect(count('idx_journal_stream')).toBe(1);
    db.close();
  });
});
