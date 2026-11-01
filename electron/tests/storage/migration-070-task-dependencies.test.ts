// electron/tests/storage/migration-070-task-dependencies.test.ts
//
// 迁移 070 专项（M3.3）：tasks + parent_task_id 列 + task_dependencies 边表。
// 锁什么：
//   - 070 已注册进 MIGRATIONS（版本顺延 69 → 70）
//   - 069 终态夹具升级后旧行 parent_task_id NULL（旧行兼容）
//   - 新列 SQL 面可写可读；repo 全链 insertTask → getTask/updateTask 持久化往返
//   - task_dependencies 表：复合主键防重复边 + CHECK 自环拒绝 + 双索引存在
//   - 边表与 repo 读链（dependencies-repo 插边 / 全图读取）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMigrations } from '../../src/main/storage/migrations';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, updateTask } from '../../src/main/storage/tasks/repo';
import {
  insertDependencyEdges,
  replaceTaskDependencies,
  listDependencyEdges,
  listParentEdges,
} from '../../src/main/storage/tasks/dependencies-repo';

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

function migration70Sql(): string {
  const mig = loadMigrations().find((x) => x.version === 70);
  if (!mig) throw new Error('migration 070 未注册进 MIGRATIONS 数组');
  return mig.sql;
}

const WS = 'ws-a';

/** 069 终态夹具：workspace + 旧形态 task 行（无 parent/依赖语义） */
function seed069(db: DB): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(WS, 'ws', '', '/tmp/ws', 0, 'u1', '📁');
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, creator_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('T-001', WS, '旧任务', 'u1', 100, 100);
}

describe('migration 070 —— 注册与升降级', () => {
  it('已注册：版本顺延 69 → 70，SQL 含列/表/双索引/CHECK', () => {
    const sql = migration70Sql();
    expect(sql).toContain('ALTER TABLE tasks ADD COLUMN parent_task_id TEXT NULL');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS task_dependencies');
    expect(sql).toContain('PRIMARY KEY (task_id, depends_on_task_id)');
    expect(sql).toContain('CHECK (task_id <> depends_on_task_id)');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_task_dependencies_task_id');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on');
    const versions = loadMigrations().map((m) => m.version);
    expect(versions).toContain(69);
    // D4（迁移 071 tasks.origin）：070 不再是末位迁移——锁顺延关系而非终位
    expect(versions.at(-1), '071 origin 列注册后 070 仍在链中（顺序完整）').toBeGreaterThan(70);
    expect(versions).toContain(70);
  });

  it('旧库升级兼容：069 终态行升 070 后 parent_task_id NULL、task_dependencies 空表', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-mig070-'));
    const db = new Database(path.join(dir, 't.db'));
    applyUpTo(db, 69);
    seed069(db);
    db.exec(migration70Sql()); // 070 up
    const row = db
      .prepare('SELECT parent_task_id FROM tasks WHERE id = ?')
      .get('T-001') as { parent_task_id: string | null };
    expect(row.parent_task_id).toBeNull();
    const edges = db.prepare('SELECT COUNT(*) AS n FROM task_dependencies').get() as { n: number };
    expect(edges.n).toBe(0);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('表约束：复合主键防重复边 + CHECK 自环拒绝', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-mig070-'));
    const db = new Database(path.join(dir, 't.db'));
    applyUpTo(db, 70);
    seed069(db);
    const ins = db.prepare(
      'INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)',
    );
    ins.run('T-002', 'T-001', 1);
    // 复合主键：重复边拒绝
    expect(() => ins.run('T-002', 'T-001', 2)).toThrow();
    // CHECK：自环拒绝（SQL 兜底层；写路径 JS 另有人话前置校验）
    expect(() => ins.run('T-001', 'T-001', 3)).toThrow(/CHECK/i);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('migration 070 —— repo 全链（runMigrations 真 db）', () => {
  const tmpRoot = path.join(
    os.tmpdir(),
    `momo-mig070-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  beforeEach(() => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
    getDb()
      .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
      .run(WS, 'Test', '/tmp', 'owner');
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('insertTask 带 parentTaskId 落列读回；缺省 NULL；updateTask 回写持久化', () => {
    const parent = insertTask({ workspaceId: WS, title: '父', creatorUserId: 'u1' });
    const child = insertTask({
      workspaceId: WS,
      title: '子',
      creatorUserId: 'u1',
      parentTaskId: parent.id,
    });
    expect(getTask(child.id)!.parentTaskId).toBe(parent.id);
    const plain = insertTask({ workspaceId: WS, title: '无父', creatorUserId: 'u1' });
    expect(getTask(plain.id)!.parentTaskId).toBeNull();
    updateTask(child.id, { parentTaskId: null });
    expect(getTask(child.id)!.parentTaskId).toBeNull();
  });

  it('dependencies-repo：插边幂等去重 / 全量替换 / 全图读取（依赖边 + 父边）', () => {
    const a = insertTask({ workspaceId: WS, title: 'A', creatorUserId: 'u1' });
    const b = insertTask({ workspaceId: WS, title: 'B', creatorUserId: 'u1' });
    const c = insertTask({ workspaceId: WS, title: 'C', creatorUserId: 'u1' });
    insertDependencyEdges(a.id, [b.id, c.id, b.id], 111); // 含重复项
    expect(listDependencyEdges()).toEqual([
      { from: a.id, to: b.id },
      { from: a.id, to: c.id },
    ]);
    // 全量替换语义：数组即最终态
    replaceTaskDependencies(a.id, [c.id]);
    expect(listDependencyEdges()).toEqual([{ from: a.id, to: c.id }]);
    replaceTaskDependencies(a.id, []);
    expect(listDependencyEdges()).toEqual([]);
    // 父边全图：挂 parent 的行才出现
    updateTask(b.id, { parentTaskId: c.id });
    expect(listParentEdges()).toEqual([{ from: b.id, to: c.id }]);
  });
});
