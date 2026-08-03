// electron/tests/migrations/013-room-settings.test.ts
//
// v1.4 迁移 v13 测试：room_settings 表存在、schema_migrations 记录、列结构正确。
// DB 隔离采用仓库既定模式：process.env.AP_USER_DATA_DIR 指向临时目录 + closeDb 复位单例。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `ap-mig13-test-${Date.now()}`);

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

describe('migration v13: room_settings', () => {
  it('room_settings 表存在', () => {
    const db = getDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='room_settings'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('room_settings');
  });

  it('schema_migrations 记录了 v13', () => {
    const db = getDb();
    const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 13').get();
    expect(row).toBeDefined();
  });

  it('room_settings 有 room_id 和 max_tool_calls 列', () => {
    const db = getDb();
    const info = db.prepare('PRAGMA table_info(room_settings)').all() as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain('room_id');
    expect(cols).toContain('max_tool_calls');
  });
});
