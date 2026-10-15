// electron/tests/storage/migration-057-plugin-registry.test.ts
//
// 057 迁移锁：两表结构可写 + schema_migrations 注册锁（范式同 migration-056-system-sender.test.ts）。
// FK 强制开启（db.ts pragma foreign_keys=ON）——plugin_enablements 写入前须先种 workspace 行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-mig057-'));

/** 种 workspace 行（FK 前置；列集对齐 journal/baseline.test.ts 的 seedWorkspace） */
function seedWorkspace(id: string): void {
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run(id, 'Test', path.join(tmpRoot, id), '@owner:home');
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('migration 057 plugin registry', () => {
  it('runMigrations 后两表存在且可写（含 FK 级联链）', () => {
    runMigrations();
    seedWorkspace('ws1');
    const db = getDb();
    db.prepare(
      `INSERT INTO plugins (id, version, manifest_json, state, source, installed_at)
       VALUES ('cg', '0.1.0', '{}', 'active', 'zip', '2026-10-15T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO plugin_enablements (workspace_id, plugin_id, enabled) VALUES ('ws1', 'cg', 0)`,
    ).run();
    const row = db
      .prepare(`SELECT plugin_id, enabled FROM plugin_enablements WHERE workspace_id = 'ws1'`)
      .get() as { plugin_id: string; enabled: number };
    expect(row).toEqual({ plugin_id: 'cg', enabled: 0 });
  });

  it('schema_migrations 注册锁：version 57 已登记', () => {
    runMigrations();
    const row = getDb().prepare(`SELECT version FROM schema_migrations WHERE version = 57`).get();
    expect(row).toBeTruthy();
  });

  it('plugins.id CHECK 约束：非法 source 拒绝', () => {
    runMigrations();
    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO plugins (id, version, manifest_json, state, source, installed_at)
           VALUES ('x', '0.1.0', '{}', 'active', 'npm', '2026-10-15T00:00:00Z')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});
