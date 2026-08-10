// electron/tests/migrations/015-agent-last-running.test.ts
//
// v1.5.8 迁移 v15 测试：agent_assignments 表新增 last_running 列，默认值 1。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `ap-mig15-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('migration v15: agent_assignments.last_running', () => {
  it('schema_migrations 记录了 v15', () => {
    const row = getDb().prepare('SELECT version FROM schema_migrations WHERE version = 15').get();
    expect(row).toBeDefined();
  });

  it('agent_assignments 表含 last_running 列', () => {
    const info = getDb().prepare('PRAGMA table_info(agent_assignments)').all() as { name: string }[];
    expect(info.map((c) => c.name)).toContain('last_running');
  });

  it('last_running 列默认值为 1（存量数据兼容）', () => {
    const db = getDb();
    // 预建 workspace + agent_definition 满足 FK
    db.prepare(
      `INSERT INTO workspaces (id, name, description, directory_path, matrix_space_id, git_initialized, owner_id, icon_emoji)
       VALUES ('ws-x', 'WS', '', '/tmp', '!s:localhost', 0, '@o:localhost', '📁')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, model_name, source)
       VALUES ('def-x', 'A', 'a', '1', 'declarative', 'p', 'gpt-4o', 'custom')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_assignments
        (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, role)
       VALUES (?, ?, ?, ?, 1, 'standalone')`,
    ).run('inst-x', 'ws-x', 'def-x', '@bot:x:localhost');
    const row = db
      .prepare('SELECT last_running FROM agent_assignments WHERE instance_id = ?')
      .get('inst-x') as { last_running: number };
    expect(row.last_running).toBe(1);
  });
});
