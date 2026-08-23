// electron/tests/migrations/019-tasks-table.test.ts
//
// v19 migration 测试：
//   1. tasks 表已创建（含所有 25 字段）
//   2. tasks 表 4 个索引齐全
//   3. messages.task_id 加 FK 指向 tasks.id（ON DELETE SET NULL，由 trigger 模拟）
//   4. room_settings 加 conflict_strategy 列（默认 'ask'）
//   5. agent_definitions 加 max_concurrent_tasks 列（默认 1）
//   6. agent_definitions 加 default_conflict_strategy 列（默认 'ask'）
//
// 注意：v23 会 RENAME COLUMN tasks.execution_room_id / source_room_id + DROP COLUMN
// workspaces.matrix_space_id + DROP TABLE room_settings。故本测试只 apply 到 v19
// （applyUpToVersion(19)），不复用 012 之前用 runMigrations() + getDb() 单例的写法——
// 后者会把 v23 也跑掉，破坏本测试断言。模式参照 012-agent-role-separation.test.ts。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

let db: DB;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  const markApplied = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)',
  );
  for (const m of loadMigrations().filter((m) => m.version <= 19)) {
    db.exec(m.sql);
    markApplied.run(m.version);
  }
});

afterAll(() => {
  db.close();
});

describe('migration v19: tasks table + conflict_strategy + agent_definitions 扩展', () => {
  it('创建 tasks 表，含所有字段', () => {
    const cols = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([
      'id', 'workspace_id', 'title', 'description', 'status',
      'source_room_id', 'source_message_id', 'creator_user_id',
      'execution_room_id', 'assignee_agent_id',
      'priority', 'scheduled_at', 'recurrence_rule', 'deadline_at',
      'queue_position', 'runtime_instance_id', 'estimated_tokens',
      'actual_tokens', 'tool_calls_used', 'error_message', 'source_node_id',
      'created_at', 'updated_at', 'started_at', 'completed_at',
    ]));
  });

  it('tasks 表索引齐全', () => {
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'").all() as Array<{ name: string }>;
    const names = idx.map((i) => i.name);
    expect(names).toContain('idx_tasks_ws_status');
    expect(names).toContain('idx_tasks_exec_room');
    expect(names).toContain('idx_tasks_assignee');
    expect(names).toContain('idx_tasks_scheduled');
  });

  it('messages.task_id 加 FK 指向 tasks.id（ON DELETE SET NULL）', () => {
    // v19 用 trigger 模拟 ON DELETE SET NULL：删除 task 时把 messages.task_id 置 NULL
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>;
    const trigName = triggers.find((t) => t.name === 'messages_task_id_null_on_delete');
    expect(trigName).toBeDefined();

    // 同时验证 trigger 行为：插入 task → messages.task_id 引用 → 删除 task → messages.task_id 自动置 NULL
    db.prepare(
      `INSERT INTO workspaces (id, name, directory_path, matrix_space_id, owner_id) VALUES (?, ?, ?, ?, ?)`,
    ).run('ws-1', 'ws', '/tmp/ws', '!space:local', '@user:local');
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, title, creator_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('task-1', 'ws-1', 't1', '@user:local', 1, 1);
    db.prepare(
      `INSERT INTO messages (id, room_id, sender, event_type, created_at, updated_at, task_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('msg-1', 'room-1', '@user:local', 'user', 1, 1, 'task-1');

    db.prepare('DELETE FROM tasks WHERE id = ?').run('task-1');

    const row = db.prepare('SELECT task_id FROM messages WHERE id = ?').get('msg-1') as { task_id: string | null };
    expect(row.task_id).toBeNull();
  });

  it('room_settings 加 conflict_strategy 列，默认 ask', () => {
    const cols = db.prepare('PRAGMA table_info(room_settings)').all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'conflict_strategy');
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe("'ask'");
  });

  it('agent_definitions 加 max_concurrent_tasks 列，默认 1', () => {
    const cols = db.prepare('PRAGMA table_info(agent_definitions)').all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'max_concurrent_tasks');
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe('1');
  });

  it('agent_definitions 加 default_conflict_strategy 列，默认 ask', () => {
    const cols = db.prepare('PRAGMA table_info(agent_definitions)').all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'default_conflict_strategy');
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe("'ask'");
  });
});
