// electron/tests/storage/migration-058-tool-call-source.test.ts
//
// 058 迁移锁：tool_calls.source 列（默认 'builtin'、可写 'plugin'）+ 注册锁。
// tool_calls 各列为纯 TEXT 无 FK（范式同 audit/query.test.ts 直插）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-mig058-'));

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('migration 058 tool_calls.source', () => {
  it('列存在：默认 builtin，可写 plugin', () => {
    runMigrations();
    getDb()
      .prepare(
        `INSERT INTO tool_calls (id, workspace_id, agent_bot_user_id, tool_name, input_summary, output_summary, success, duration_ms)
         VALUES ('t1', 'ws1', 'u1', 'read_file', 'i', 'o', 1, 5)`,
      )
      .run();
    const defRow = getDb()
      .prepare(`SELECT source FROM tool_calls WHERE id = 't1'`)
      .get() as { source: string };
    expect(defRow.source).toBe('builtin');
    getDb()
      .prepare(
        `INSERT INTO tool_calls (id, workspace_id, agent_bot_user_id, tool_name, input_summary, output_summary, success, duration_ms, source)
         VALUES ('t2', 'ws1', 'u1', 'plugin:cg/explore', 'i', 'o', 1, 5, 'plugin')`,
      )
      .run();
    const pluginRow = getDb()
      .prepare(`SELECT source FROM tool_calls WHERE id = 't2'`)
      .get() as { source: string };
    expect(pluginRow.source).toBe('plugin');
  });

  it('schema_migrations 注册锁：version 58 已登记', () => {
    runMigrations();
    expect(getDb().prepare(`SELECT version FROM schema_migrations WHERE version = 58`).get()).toBeTruthy();
  });
});
