// electron/tests/storage/migration-v26.test.ts
// 迁移 v26 测试：修复 v25 遗留债务——重建 agent_assignment_capabilities 的 FK。
//
// v25 DROP agent_assignments 时未重建本表外键，assignment_id 悬挂引用已删表：
// foreign_keys=ON 下任何 INSERT 即报 no such table: agent_assignments，
// 生产写路径 agent:setMemberDeltas 必炸（T10 审查移交债务①）。
//
// v26 契约（task-10b-brief）：
//   1. FK 改指 workspace_agent_members(instance_id) ON DELETE CASCADE，其余列保留
//   2. 数据搬运无损（instance_id 仍有效的行四列原样保留）
//   3. instance_id 引用失效的行按级联语义清理（不搬运）
//
// 模式参照 migration-v25.test.ts：内存 DB + foreign_keys=ON 顺序执行 loadMigrations()。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

const V25 = 25;

/** 在 db 上应用 <= version 的全部迁移并登记 schema_migrations（与 v25 测试同法） */
function applyUpTo(db: DB, version: number): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  const markApplied = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)',
  );
  for (const m of loadMigrations()) {
    if (m.version > version) break;
    db.exec(m.sql);
    markApplied.run(m.version);
  }
}

/** 应用 afterVersion 之后的全部迁移（当前即 v26） */
function applyRemaining(db: DB, afterVersion: number): void {
  const markApplied = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)',
  );
  for (const m of loadMigrations()) {
    if (m.version <= afterVersion) continue;
    db.exec(m.sql);
    markApplied.run(m.version);
  }
}

/** 全新空库直接升到最新（空数据路径：迁移不炸、表结构就位） */
function buildMigratedDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const latest = Math.max(...loadMigrations().map((m) => m.version));
  applyUpTo(db, latest);
  return db;
}

/** v25 库 + fixture 注入 → 升级 v26（数据搬运用例的公共骨架） */
function buildV25DbWithFixture(seed: (db: DB) => void): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyUpTo(db, V25);
  seed(db);
  applyRemaining(db, V25);
  return db;
}

function tableColumns(db: DB, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

interface FkRow {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

/** 某表的全部外键声明（PRAGMA foreign_key_list） */
function foreignKeys(db: DB, table: string): FkRow[] {
  return db.prepare(`PRAGMA foreign_key_list('${table}')`).all() as FkRow[];
}

/** v25 fixture 最小集：workspace + agent 定义 + 一个成员实例 */
function seedWorkspaceAndMember(db: DB): void {
  db.exec(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws1', 'WS', '', '/tmp', 0, '@owner:s', '📁')`,
  );
  db.exec(
    `INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name)
     VALUES ('def-1', 'A', 'a', '1.0.0', 'prompt', 'm1')`,
  );
  db.exec(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES ('inst-1', 'ws1', 'def-1', 'agent-a-ab12cd')`,
  );
}

/** 直插 delta 行（测试内绕 FK 用；v26 后正常路径可直接插） */
function insertDelta(
  db: DB,
  instanceId: string,
  type: string,
  mode: string,
  ref: string,
): void {
  db.prepare(
    'INSERT INTO agent_assignment_capabilities (assignment_id, capability_type, mode, ref) VALUES (?, ?, ?, ?)',
  ).run(instanceId, type, mode, ref);
}

describe('migration v26：重建 agent_assignment_capabilities FK', () => {
  it('空库路径：FK 改指 workspace_agent_members(instance_id) ON DELETE CASCADE，四列与 PK 保留', () => {
    const db = buildMigratedDb();
    // 列清单与 v16 完全一致（其余列保留）
    const cols = tableColumns(db, 'agent_assignment_capabilities');
    expect(cols).toHaveLength(4);
    expect(cols).toEqual(
      expect.arrayContaining(['assignment_id', 'capability_type', 'mode', 'ref']),
    );
    // PK 仍为四列复合主键
    const pkCols = (
      db.prepare(`PRAGMA table_info('agent_assignment_capabilities')`).all() as Array<{
        name: string;
        pk: number;
      }>
    )
      .filter((c) => c.pk > 0)
      .map((c) => c.name)
      .sort();
    expect(pkCols).toEqual(['assignment_id', 'capability_type', 'mode', 'ref']);
    // FK 单条，指向 workspace_agent_members(instance_id)，ON DELETE CASCADE
    const fks = foreignKeys(db, 'agent_assignment_capabilities');
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({
      table: 'workspace_agent_members',
      from: 'assignment_id',
      to: 'instance_id',
      on_delete: 'CASCADE',
    });
    db.close();
  });

  it('生产断裂修复：FK=ON 下对有效成员写 delta 成功（v25 态此写路径必炸）', () => {
    const db = buildV25DbWithFixture((d) => {
      seedWorkspaceAndMember(d);
    });
    // v26 后 INSERT 恢复（v25 终态下同语句报 no such table: agent_assignments）
    insertDelta(db, 'inst-1', 'tool', 'add', 'bash');
    const rows = db
      .prepare('SELECT * FROM agent_assignment_capabilities')
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assignment_id: 'inst-1',
      capability_type: 'tool',
      mode: 'add',
      ref: 'bash',
    });
    db.close();
  });

  it('FK 真实生效：指向不存在成员的 INSERT 被拒绝（非装饰性外键）', () => {
    const db = buildV25DbWithFixture((d) => {
      seedWorkspaceAndMember(d);
    });
    expect(() => insertDelta(db, 'ghost-inst', 'tool', 'add', 'bash')).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    db.close();
  });

  it('数据搬运无损 + 失效引用清理：有效 instance_id 行四列原样保留，失效行不搬运', () => {
    const db = buildV25DbWithFixture((d) => {
      seedWorkspaceAndMember(d);
      // v25 的 DROP TABLE 级联会清空正常路径数据；此处模拟防御路径——
      // FK 关闭期间残留的行（有效 inst-1 × 3 行 + 失效 ghost × 1 行）
      d.pragma('foreign_keys = OFF');
      insertDelta(d, 'inst-1', 'tool', 'add', 'bash');
      insertDelta(d, 'inst-1', 'tool', 'remove', 'git_commit');
      insertDelta(d, 'inst-1', 'mcp', 'add', 'github');
      insertDelta(d, 'ghost-inst', 'skill', 'add', 'code-review');
      d.pragma('foreign_keys = ON');
    });
    const rows = db
      .prepare(
        'SELECT assignment_id, capability_type, mode, ref FROM agent_assignment_capabilities ORDER BY capability_type, mode, ref',
      )
      .all() as Array<Record<string, string>>;
    // 有效行三行四列原样保留；失效行（ghost-inst）按级联语义清理
    expect(rows).toEqual([
      { assignment_id: 'inst-1', capability_type: 'mcp', mode: 'add', ref: 'github' },
      { assignment_id: 'inst-1', capability_type: 'tool', mode: 'add', ref: 'bash' },
      { assignment_id: 'inst-1', capability_type: 'tool', mode: 'remove', ref: 'git_commit' },
    ]);
    db.close();
  });

  it('级联语义：删除成员行 → 其 delta 行自动清理（ON DELETE CASCADE 贯通新 FK）', () => {
    const db = buildV25DbWithFixture((d) => {
      seedWorkspaceAndMember(d);
    });
    insertDelta(db, 'inst-1', 'tool', 'add', 'bash');
    db.prepare('DELETE FROM workspace_agent_members WHERE instance_id = ?').run('inst-1');
    expect(
      db.prepare('SELECT COUNT(*) c FROM agent_assignment_capabilities').get(),
    ).toMatchObject({ c: 0 });
    db.close();
  });

  it('v25 正常路径（delta 已被级联清空）升级 v26：空表安全通过', () => {
    const db = buildV25DbWithFixture((d) => {
      seedWorkspaceAndMember(d);
      // v24 时代挂 delta 的 assignment 在 v25 DROP TABLE 时已被级联清空——
      // 真实升级路径下 v26 面对的是空表
      const before = (
        d.prepare('SELECT COUNT(*) c FROM agent_assignment_capabilities').get() as {
          c: number;
        }
      ).c;
      expect(before).toBe(0);
    });
    expect(
      db.prepare('SELECT COUNT(*) c FROM agent_assignment_capabilities').get(),
    ).toMatchObject({ c: 0 });
    // 写读路径仍恢复
    insertDelta(db, 'inst-1', 'tool', 'add', 'bash');
    expect(
      db.prepare('SELECT COUNT(*) c FROM agent_assignment_capabilities').get(),
    ).toMatchObject({ c: 1 });
    db.close();
  });
});
