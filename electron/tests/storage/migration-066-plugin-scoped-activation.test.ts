// electron/tests/storage/migration-066-plugin-scoped-activation.test.ts
//
// 066 迁移锁：enablements 存量全量回填（存量决策 A——全部 ws × plugin 保持启用）。
// 范式同 migration-057-plugin-registry.test.ts：up SQL 语义直测 + schema_migrations 注册锁。
// skill 物化不在迁移内（纯 SQL 无法扫盘）——由启动期回填承担（legacy-grants，另测）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import { migration066 } from '../../src/main/storage/migrations/066_plugin_scoped_activation';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-mig066-'));

/** 种 workspace 行（FK 前置；列集对齐 migration-057 seedWorkspace） */
function seedWorkspace(id: string): void {
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run(id, 'Test', path.join(tmpRoot, id), '@owner:home');
}

/** 种 plugin 行 */
function seedPlugin(id: string): void {
  getDb()
    .prepare(
      `INSERT INTO plugins (id, version, manifest_json, state, source, installed_at)
       VALUES (?, '1.0.0', '{}', 'active', 'zip', '2026-01-01T00:00:00Z')`,
    )
    .run(id);
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

describe('migration 066 plugin scoped activation', () => {
  it('存量 ws × plugin 全部回填 enabled=1；幂等重放行数不变', () => {
    runMigrations();
    seedWorkspace('w1');
    seedWorkspace('w2');
    seedPlugin('p1');
    seedPlugin('p2');
    const db = getDb();

    db.exec(migration066.up);
    let rows = db
      .prepare(`SELECT workspace_id, plugin_id, enabled FROM plugin_enablements ORDER BY workspace_id, plugin_id`)
      .all() as Array<{ workspace_id: string; plugin_id: string; enabled: number }>;
    expect(rows).toEqual([
      { workspace_id: 'w1', plugin_id: 'p1', enabled: 1 },
      { workspace_id: 'w1', plugin_id: 'p2', enabled: 1 },
      { workspace_id: 'w2', plugin_id: 'p1', enabled: 1 },
      { workspace_id: 'w2', plugin_id: 'p2', enabled: 1 },
    ]);

    db.exec(migration066.up); // 幂等重放
    const count = db.prepare(`SELECT COUNT(*) AS c FROM plugin_enablements`).get() as { c: number };
    expect(count.c).toBe(4);
  });

  it('回填不覆盖用户显式停用行（OR IGNORE 语义）', () => {
    runMigrations();
    seedWorkspace('w1');
    seedPlugin('p1');
    const db = getDb();
    db.prepare(`INSERT INTO plugin_enablements (workspace_id, plugin_id, enabled) VALUES ('w1', 'p1', 0)`).run();
    db.exec(migration066.up);
    const row = db
      .prepare(`SELECT enabled FROM plugin_enablements WHERE workspace_id = 'w1' AND plugin_id = 'p1'`)
      .get() as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  it('schema_migrations 注册锁：version 66 已登记', () => {
    runMigrations();
    const row = getDb().prepare(`SELECT version FROM schema_migrations WHERE version = 66`).get();
    expect(row).toBeTruthy();
  });
});
