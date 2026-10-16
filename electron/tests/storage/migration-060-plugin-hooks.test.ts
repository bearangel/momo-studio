// electron/tests/storage/migration-060-plugin-hooks.test.ts
//
// 060 迁移锁：hook_calls 审计表（spec §5.4）+ tool_calls.pre_tool_use 决策列。
// tool_calls 各列纯 TEXT 无 FK（范式同 audit/query.test.ts 直插）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-mig060-'));

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('migration 060 plugin hooks audit', () => {
  it('hook_calls 表全字段可写', () => {
    runMigrations();
    getDb()
      .prepare(
        `INSERT INTO hook_calls (id, plugin_id, event, matcher, decision, duration_ms, success)
         VALUES ('h1', 'cg', 'preToolUse', 'git_*', '{"action":"deny"}', 3, 1)`,
      )
      .run();
    const row = getDb()
      .prepare(`SELECT * FROM hook_calls WHERE id = 'h1'`)
      .get() as Record<string, unknown>;
    expect(row.plugin_id).toBe('cg');
    expect(row.event).toBe('preToolUse');
    expect(row.matcher).toBe('git_*');
    expect(row.decision).toBe('{"action":"deny"}');
    expect(row.duration_ms).toBe(3);
    expect(row.success).toBe(1);
  });

  it('matcher/decision 可空', () => {
    runMigrations();
    getDb()
      .prepare(
        `INSERT INTO hook_calls (id, plugin_id, event, duration_ms, success)
         VALUES ('h2', 'cg', 'taskCompleted', 1, 1)`,
      )
      .run();
    const row = getDb().prepare(`SELECT matcher, decision FROM hook_calls WHERE id = 'h2'`).get() as {
      matcher: string | null;
      decision: string | null;
    };
    expect(row.matcher).toBeNull();
    expect(row.decision).toBeNull();
  });

  it('tool_calls.pre_tool_use 列：null 默认与显式值两态', () => {
    runMigrations();
    getDb()
      .prepare(
        `INSERT INTO tool_calls (id, workspace_id, agent_bot_user_id, tool_name, input_summary, output_summary, success, duration_ms)
         VALUES ('t1', 'ws1', 'u1', 'bash', 'i', 'o', 1, 5)`,
      )
      .run();
    getDb()
      .prepare(
        `INSERT INTO tool_calls (id, workspace_id, agent_bot_user_id, tool_name, input_summary, output_summary, success, duration_ms, pre_tool_use)
         VALUES ('t2', 'ws1', 'u1', 'bash', 'i', 'o', 0, 5, '[{"pluginId":"cg","action":"deny"}]')`,
      )
      .run();
    const r1 = getDb().prepare(`SELECT pre_tool_use FROM tool_calls WHERE id = 't1'`).get() as {
      pre_tool_use: string | null;
    };
    const r2 = getDb().prepare(`SELECT pre_tool_use FROM tool_calls WHERE id = 't2'`).get() as {
      pre_tool_use: string | null;
    };
    expect(r1.pre_tool_use).toBeNull();
    expect(r2.pre_tool_use).toBe('[{"pluginId":"cg","action":"deny"}]');
  });

  it('schema_migrations 注册锁：version 60 已登记', () => {
    runMigrations();
    expect(getDb().prepare(`SELECT version FROM schema_migrations WHERE version = 60`).get()).toBeTruthy();
  });
});
