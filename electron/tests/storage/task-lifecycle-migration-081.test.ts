// electron/tests/storage/task-lifecycle-migration-081.test.ts
//
// 迁移 081 专项（任务生命周期 v2，spec 2026-11-13 §5.5）：tasks 五列 +
// messages.meta_json + task_runs + human_requests。锁什么：
//   - tasks 新五列（current_run_id / submitted_at / accepted_at /
//     delegation_role / auto_accept）可写可读
//   - task_runs 单活动 run 部分唯一索引（running/waiting_human/submitted 占槽）
//   - human_requests 镜像唯一约束（origin_node_id+remote_id）；本地行 NULL 互不冲突
//   - messages.meta_json 列存在
// 测试基座沿用同目录既有 migration 测试模式：内存 better-sqlite3 库跑全量迁移
// （applyUpTo 81），foreign_keys=ON —— tasks/sessions 外键指 workspaces，先插父行。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

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

/** 081 终态库：内存库跑迁移至 081（含）+ FK 父行种子（workspaces 'ws'）。 */
function setupTestDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyUpTo(db, 81);
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('ws', 'ws', '', '/tmp/ws', 0, 'u1', '📁');
  return db;
}

describe('migration 081 task_lifecycle_v2', () => {
  it('tasks 新增五列可写可读', () => {
    const db = setupTestDb();
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, title, status, creator_user_id, created_at, updated_at,
         current_run_id, submitted_at, accepted_at, delegation_role, auto_accept)
       VALUES ('T-1','ws','t','draft','u',0,0,NULL,NULL,NULL,'out',1)`,
    ).run();
    const row = db.prepare('SELECT delegation_role, auto_accept FROM tasks WHERE id=?').get('T-1') as {
      delegation_role: string; auto_accept: number;
    };
    expect(row.delegation_role).toBe('out');
    expect(row.auto_accept).toBe(1);
  });

  it('task_runs 单活动 run 部分唯一索引生效', () => {
    const db = setupTestDb();
    db.prepare(`INSERT INTO tasks (id, workspace_id, title, status, creator_user_id, created_at, updated_at)
       VALUES ('T-1','ws','t','in_progress','u',0,0)`).run();
    const ins = db.prepare(
      `INSERT INTO task_runs (id, task_id, run_no, status, trigger, started_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    ins.run('r1', 'T-1', 1, 'running', 'initial', 0, 0, 0);
    expect(() => ins.run('r2', 'T-1', 2, 'waiting_human', 'initial', 0, 0, 0)).toThrow();
    ins.run('r3', 'T-1', 3, 'failed', 'initial', 0, 0, 0); // 终态不占活动槽，不抛
  });

  it('human_requests 镜像唯一约束（origin_node_id+remote_id）且本地行不受限', () => {
    const db = setupTestDb();
    db.prepare(`INSERT INTO sessions (id, workspace_id, title, kind, created_at, updated_at)
       VALUES ('s1','ws','t','chat',0,0)`).run();
    const ins = db.prepare(
      `INSERT INTO human_requests (id, session_id, kind, status, title, timeout_policy, created_at, updated_at,
         origin_node_id, remote_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    ins.run('q1', 's1', 'question', 'pending', 't', 'keep_waiting', 0, 0, 'nodeA', 'rq1');
    expect(() => ins.run('q2', 's1', 'question', 'pending', 't', 'keep_waiting', 0, 0, 'nodeA', 'rq1')).toThrow();
    ins.run('q3', 's1', 'question', 'pending', 't', 'keep_waiting', 0, 0, null, null); // 本地行 NULL 互不冲突
  });

  it('messages.meta_json 列存在', () => {
    const db = setupTestDb();
    db.prepare(`INSERT INTO messages (id, session_id, sender, event_type, body, status, source, created_at, updated_at, meta_json)
       VALUES ('m1','s1','system','delegation_milestone','x','done','local',0,0,'{"k":1}')`).run();
    expect(db.prepare('SELECT meta_json FROM messages WHERE id=?').get('m1')).toBeTruthy();
  });
});
