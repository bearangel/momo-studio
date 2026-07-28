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
});