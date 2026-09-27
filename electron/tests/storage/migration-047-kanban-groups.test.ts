// electron/tests/storage/migration-047-kanban-groups.test.ts
//
// 迁移 v047 老库升级专项测试（看板重构终审 I2）：构造 v46 终态库 → 插入
// workspaces / tasks 既有行 → 跑 047 → 断言老数据零处理开箱即用：
//   1. 老行三新列 group_id / board_position / archived_at 均 NULL
//   2. 既有行数据无损（title / status / workspace_id 不变）
//   3. task_groups 表存在（8 列）；idx_tasks_ws_archived /
//      idx_task_groups_ws 两索引存在且覆盖列正确
//
// 模式照抄 migration-v33.test.ts：内存库跑真实迁移到 v46（指定迁移上限）→
// 从 loadMigrations() 取 v47（走生产注册路径而非直接 import 模块——
// 注册缺失应在第一时间红）。

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

const V46 = 46;

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

/** 经 loadMigrations() 生产注册路径取 v47；未注册时给明确的红 */
function getMigration47Sql(): string {
  const m = loadMigrations().find((x) => x.version === 47);
  if (!m) throw new Error('migration v47 未注册进 MIGRATIONS 数组');
  return m.sql;
}

interface TaskBrief {
  id: string;
  title: string;
  status: string;
  workspace_id: string;
  group_id: string | null;
  board_position: number | null;
  archived_at: number | null;
}

function getTask(db: DB, id: string): TaskBrief {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskBrief | undefined;
  if (!row) throw new Error(`任务行 ${id} 不存在（既有数据丢失）`);
  return row;
}

/** 取索引定义并压缩全部空白（对格式化不敏感，仍锁定 表名+覆盖列） */
function indexSql(db: DB, name: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?")
    .get(name) as { sql: string } | undefined;
  if (!row) throw new Error(`索引 ${name} 不存在`);
  return row.sql.replace(/\s+/g, '');
}

/** 构造 v46 终态库并插入既有行：1 workspace + 2 tasks（一活跃一终态） */
function seedV46(db: DB): void {
  applyUpTo(db, V46);
  db.prepare(
    // matrix_space_id 已于早期迁移 DROP（P1 拆 Matrix），v46 终态无该列
    `INSERT INTO workspaces (id, name, directory_path, owner_id)
     VALUES ('ws-1', '老库工作区', '/tmp/ws-1', 'owner')`,
  ).run();
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, status, creator_user_id, created_at, updated_at)
     VALUES (?, 'ws-1', ?, ?, 'owner', 1000, 1000)`,
  );
  insertTask.run('T-active', '进行中任务', 'in_progress');
  insertTask.run('T-done', '已完成任务', 'completed');
}

describe('migration v047：v46 老库升级（task_groups + tasks 三新列）', () => {
  it('v47 注册进 loadMigrations；升级前 task_groups 表与三新列不存在（防既有残留假绿）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    seedV46(db);

    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_groups'")
        .get(),
    ).toBeUndefined();
    const cols = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('group_id');
    expect(cols).not.toContain('board_position');
    expect(cols).not.toContain('archived_at');
    db.close();
  });

  it('老行三新列均 NULL 且既有数据无损（title/status/workspace_id 不变）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    seedV46(db);

    db.exec(getMigration47Sql());

    for (const id of ['T-active', 'T-done']) {
      const row = getTask(db, id);
      expect(row.group_id).toBeNull();
      expect(row.board_position).toBeNull();
      expect(row.archived_at).toBeNull();
    }
    // 既有数据无损：业务字段原样保留
    expect(getTask(db, 'T-active')).toMatchObject({
      title: '进行中任务',
      status: 'in_progress',
      workspace_id: 'ws-1',
    });
    expect(getTask(db, 'T-done')).toMatchObject({
      title: '已完成任务',
      status: 'completed',
      workspace_id: 'ws-1',
    });
    db.close();
  });

  it('task_groups 表存在（8 列结构）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    seedV46(db);
    db.exec(getMigration47Sql());

    const cols = db.prepare('PRAGMA table_info(task_groups)').all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    // id 为 TEXT PRIMARY KEY（无显式 NOT NULL）——SQLite PRAGMA 报 notnull=0，锁真实 schema
    expect(cols.map((c) => ({ name: c.name, notnull: c.notnull, pk: c.pk }))).toEqual([
      { name: 'id', notnull: 0, pk: 1 },
      { name: 'workspace_id', notnull: 1, pk: 0 },
      { name: 'name', notnull: 1, pk: 0 },
      { name: 'color', notnull: 0, pk: 0 },
      { name: 'position', notnull: 1, pk: 0 },
      { name: 'archived_at', notnull: 0, pk: 0 },
      { name: 'created_at', notnull: 1, pk: 0 },
      { name: 'updated_at', notnull: 1, pk: 0 },
    ]);
    db.close();
  });

  it('两索引存在且覆盖列正确（tasks 归档过滤 / task_groups 按工作区查）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    seedV46(db);
    db.exec(getMigration47Sql());

    // 空白已全压缩：期望串内不留空格
    expect(indexSql(db, 'idx_tasks_ws_archived')).toContain('ONtasks(workspace_id,archived_at)');
    expect(indexSql(db, 'idx_task_groups_ws')).toContain('ONtask_groups(workspace_id)');
    db.close();
  });

  it('幂等回归锁：升级后老行 group_id 可写入引用行（FK 到 task_groups）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    seedV46(db);
    db.exec(getMigration47Sql());

    db.prepare(
      `INSERT INTO task_groups (id, workspace_id, name, position, created_at, updated_at)
       VALUES ('g-1', 'ws-1', '组1', 1024, 1, 1)`,
    ).run();
    db.prepare('UPDATE tasks SET group_id = ?, board_position = ? WHERE id = ?').run(
      'g-1',
      2048,
      'T-done',
    );
    const row = getTask(db, 'T-done');
    expect(row.group_id).toBe('g-1');
    expect(row.board_position).toBe(2048);
    db.close();
  });
});
