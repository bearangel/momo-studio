// electron/tests/storage/db.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, runMigrations, closeDb } from '../../src/main/storage/db';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpRoot = path.join(os.tmpdir(), `ap-db-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('storage/db', () => {
  it('runMigrations creates kv_store table', () => {
    runMigrations();
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('kv_store');
  });

  it('kv_store round-trips a value', () => {
    runMigrations();
    const db = getDb();
    db.prepare('INSERT INTO kv_store (key, value) VALUES (?, ?)').run('foo', '"bar"');
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('foo') as {
      value: string;
    };
    expect(row.value).toBe('"bar"');
  });

  it('runMigrations is idempotent', () => {
    runMigrations();
    runMigrations();
    const db = getDb();
    const count = (
      db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='kv_store'").get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it('runMigrations creates tool_calls table with indexes（migration v6）', () => {
    runMigrations();
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('tool_calls');

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tool_calls'")
      .all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_tool_calls_workspace_ts');
    expect(indexNames).toContain('idx_tool_calls_agent');
  });

  it('runMigrations 创建 model_providers 表', () => {
    runMigrations();
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('model_providers');
  });

  it('model_providers 表有 is_default 列', () => {
    runMigrations();
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(model_providers)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('is_default');
  });

  it('runMigrations 给 workspaces 加 coordinator_instance_id 列（migration v11）', () => {
    runMigrations();
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('coordinator_instance_id');
  });
});