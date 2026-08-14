// electron/tests/migrations/022-task-driven.test.ts
//
// v22 migration 测试：task-driven runtime 切换——agent_definitions 加 task_driven 字段
//   1. agent_definitions 加 task_driven 列（NOT NULL DEFAULT 1）
//   2. 现有 builtin / 自定义 agent 不显式指定 task_driven 时默认为 1
//
// 语义：
//   1 = task-driven runtime（v2 默认）
//   0 = v1 runtime-manager（fallback，留 1 版本可用）
//
// 详见 docs/specs/2026-08-14-td-task-driven-runtime.md 的相关章节。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `ap-mig22-${Date.now()}`);

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

describe('migration v22: agent_definitions.task_driven', () => {
  it('agent_definitions 加 task_driven 列，默认 1', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(agent_definitions)').all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'task_driven');
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe('1');
  });

  it('现有 builtin agent 的 task_driven 默认为 1', () => {
    const db = getDb();
    // 插入一个 agent_definition 不指定 task_driven
    db.prepare(
      `INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_provider_id, model_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('test1', 'Test', 'test', '1.0', '', 'provider-1', 'm1');
    const row = db.prepare('SELECT task_driven FROM agent_definitions WHERE id = ?').get('test1') as { task_driven: number };
    expect(row.task_driven).toBe(1);
  });
});
