// electron/tests/migrations/018-drop-agent-meta.test.ts
//
// v18 migration 测试：
//   1. agent_meta 表已删除（DROP TABLE IF EXISTS）
//   2. messages + message_events 表仍存在（v17 结构不受影响）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `ap-mig18-test-${Date.now()}`);

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

describe('migration v18: drop agent_meta', () => {
  it('agent_meta 表已删除', () => {
    const db = getDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_meta'")
      .get() as { name: string } | undefined;
    expect(row).toBeUndefined();
  });

  it('messages + message_events 表仍存在', () => {
    const db = getDb();
    const msgs = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
      .get();
    const evts = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_events'")
      .get();
    expect(msgs).toBeDefined();
    expect(evts).toBeDefined();
  });
});
