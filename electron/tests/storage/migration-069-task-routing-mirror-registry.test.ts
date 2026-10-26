// electron/tests/storage/migration-069-task-routing-mirror-registry.test.ts
//
// 迁移 069 专项（M2.1 Task 6）：tasks 表 + routing_json/delegation_id 两列 +
// workspace_mirror_registry 新表。锁什么：
//   - 069 已注册进 MIGRATIONS（版本顺延 68 → 69）
//   - 旧迁移前行（无两列语义）升级后 routing_json/delegation_id 均 NULL（旧行兼容）
//   - 新列可写可读（SQL 面）
//   - workspace_mirror_registry 表存在 + UNIQUE(group_id,target_node_id,workspace_name)
//   - repo 全链（runMigrations 真 db）：insertTask 带 routing 落列读回（解析形态）、
//     delegationId 缺省 NULL、updateTask 回写 delegationId 持久化（T8/T9 数据面）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMigrations } from '../../src/main/storage/migrations';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, updateTask, listTasks } from '../../src/main/storage/tasks/repo';

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

function migration69Sql(): string {
  const mig = loadMigrations().find((x) => x.version === 69);
  if (!mig) throw new Error('migration 069 未注册进 MIGRATIONS 数组');
  return mig.sql;
}

const WS = 'ws-a';

/** 068 终态夹具：workspace + 旧形态 task 行（无 routing/delegation 语义） */
function seed068(db: DB): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(WS, 'ws', '', '/tmp/ws', 0, 'u1', '📁');
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, creator_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('T-001', WS, '旧任务', 'u1', 100, 100);
}

describe('migration 069：tasks 两列 + workspace_mirror_registry 表', () => {
  it('069 已注册且版本顺延（68 → 69）', () => {
    const versions = loadMigrations().map((x) => x.version);
    expect(versions).toContain(68);
    expect(versions).toContain(69);
    expect(Math.max(...versions)).toBe(69);
  });

  it('旧行升级后 routing_json / delegation_id 均 NULL（迁移前任务行兼容）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, 68);
    seed068(db);
    db.exec(migration69Sql());
    const row = db.prepare('SELECT routing_json, delegation_id FROM tasks WHERE id = ?').get('T-001') as {
      routing_json: string | null;
      delegation_id: string | null;
    };
    expect(row.routing_json).toBeNull();
    expect(row.delegation_id).toBeNull();
    db.close();
  });

  it('新列 SQL 面可写可读', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, 68);
    seed068(db);
    db.exec(migration69Sql());
    db.prepare(`UPDATE tasks SET routing_json = ?, delegation_id = ? WHERE id = ?`).run(
      '{"mode":"node","groupId":"g-1","targetNodeId":"n-2"}',
      'del-9',
      'T-001',
    );
    const row = db.prepare('SELECT routing_json, delegation_id FROM tasks WHERE id = ?').get('T-001') as {
      routing_json: string | null;
      delegation_id: string | null;
    };
    expect(JSON.parse(row.routing_json!)).toEqual({
      mode: 'node',
      groupId: 'g-1',
      targetNodeId: 'n-2',
    });
    expect(row.delegation_id).toBe('del-9');
    db.close();
  });

  it('workspace_mirror_registry 建表 + UNIQUE(group_id,target_node_id,workspace_name)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, 68);
    db.exec(migration69Sql());
    const ins = db.prepare(
      `INSERT INTO workspace_mirror_registry (group_id, target_node_id, workspace_name, snapshot_id, mirrored_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    ins.run('g-1', 'n-2', 'ws-a', 'snap-1', 1);
    expect(() => ins.run('g-1', 'n-2', 'ws-a', 'snap-2', 2)).toThrow(/UNIQUE/i);
    // 键不同可并存
    ins.run('g-1', 'n-2', 'ws-b', 'snap-1', 3);
    const n = db.prepare('SELECT COUNT(*) AS c FROM workspace_mirror_registry').get() as { c: number };
    expect(n.c).toBe(2);
    db.close();
  });
});

// ── repo 全链集成（真 migrations + tasks repo 读写面）──

const tmpRoot = path.join(os.tmpdir(), `ap-mig069-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`,
  ).run('ws1', 'Test', '/tmp', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('tasks repo × routing/delegation 数据面', () => {
  it('insertTask 带 routing → 落列 + getTask 解析回形状；delegationId 缺省 null', () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: '外派任务',
      creatorUserId: '@owner:home',
      routing: { mode: 'node', groupId: 'g-1', targetNodeId: 'n-2' },
    });
    expect(t.routing).toEqual({ mode: 'node', groupId: 'g-1', targetNodeId: 'n-2' });
    expect(t.delegationId).toBeNull();
    const back = getTask(t.id)!;
    expect(back.routing).toEqual({ mode: 'node', groupId: 'g-1', targetNodeId: 'n-2' });
    // 列本体存的是规范 JSON（非 NULL——显式 local 也该落 JSON，未指定才落 NULL）
    const raw = getDb()
      .prepare('SELECT routing_json FROM tasks WHERE id = ?')
      .get(t.id) as { routing_json: string | null };
    expect(JSON.parse(raw.routing_json!)).toEqual({ mode: 'node', groupId: 'g-1', targetNodeId: 'n-2' });
  });

  it('insertTask 不带 routing → 列 NULL + 读侧 local（旧行为零变化）', () => {
    const t = insertTask({ workspaceId: 'ws1', title: '本机任务', creatorUserId: '@owner:home' });
    expect(t.routing).toEqual({ mode: 'local' });
    const raw = getDb()
      .prepare('SELECT routing_json FROM tasks WHERE id = ?')
      .get(t.id) as { routing_json: string | null };
    expect(raw.routing_json).toBeNull();
  });

  it('updateTask 回写 delegationId / routing → 持久化（T8 回写 / T9 同步数据面）', () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: '待派发',
      creatorUserId: '@owner:home',
      routing: { mode: 'group', groupId: 'g-1' },
    });
    updateTask(t.id, { delegationId: 'del-42', routing: { mode: 'node', groupId: 'g-1', targetNodeId: 'n-3' } });
    const back = getTask(t.id)!;
    expect(back.delegationId).toBe('del-42');
    expect(back.routing).toEqual({ mode: 'node', groupId: 'g-1', targetNodeId: 'n-3' });
  });

  it('listTasks 行携带 routing / delegationId（camelCase 惯例）', () => {
    insertTask({ workspaceId: 'ws1', title: 'a', creatorUserId: 'u', routing: { mode: 'group', groupId: 'g-1' } });
    insertTask({ workspaceId: 'ws1', title: 'b', creatorUserId: 'u' });
    const rows = listTasks({ workspaceId: 'ws1' });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => typeof r.routing.mode === 'string' && ('delegationId' in r))).toBe(true);
    const routed = rows.find((r) => r.routing.mode === 'group');
    expect(routed?.routing).toEqual({ mode: 'group', groupId: 'g-1' });
  });
});
