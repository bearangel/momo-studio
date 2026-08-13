// electron/tests/migrations/021-concurrency-fields.test.ts
//
// v21 migration 测试：D 子系统——并发控制字段
//   1. global_settings 表已创建（v21 把它从 kv_store JSON 升为独立单行配置表）
//   2. global_settings.max_concurrent_tasks INTEGER NOT NULL DEFAULT 3
//   3. global_settings.warm_pool_size INTEGER NOT NULL DEFAULT 2
//   4. model_providers 加 max_rpm INTEGER（nullable = 不限流）
//   5. model_providers 加 max_tpm INTEGER（nullable = 不限流）
// 详见 docs/plans/2026-08-13-platform-redesign-d-task-board-concurrency.md Task D1。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `ap-mig21-${Date.now()}`);

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

describe('migration v21: 并发控制字段', () => {
  it('global_settings 加 max_concurrent_tasks（默认 3）', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(global_settings)').all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'max_concurrent_tasks');
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe('3');
  });

  it('global_settings 加 warm_pool_size（默认 2）', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(global_settings)').all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'warm_pool_size');
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe('2');
  });

  it('model_providers 加 max_rpm 列', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(model_providers)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'max_rpm')).toBe(true);
  });

  it('model_providers 加 max_tpm 列', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(model_providers)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'max_tpm')).toBe(true);
  });
});
