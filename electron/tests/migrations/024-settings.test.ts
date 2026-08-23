// electron/tests/migrations/024-settings.test.ts
// 迁移 v24 测试：model_providers 加 platform 列（CHECK openai/anthropic + 默认 'openai'）、
// provider_models 新表（双主键 + 级联删除）、workspaces 加 audit_quota_mb 列。
//
// 模式参照 023-sessions.test.ts：内存 DB 顺序执行 loadMigrations() 的 SQL。
// 额外用 applyUpTo(23) 验证 v24 前已存在的 provider 行 platform 自动回填 'openai'。
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations, type Migration } from '../../src/main/storage/migrations';

let db: DB;

function applyUpTo(version: number): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  const markApplied = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)',
  );
  const migrations = [...loadMigrations()].sort((a: Migration, b: Migration) => a.version - b.version);
  for (const m of migrations) {
    if (m.version > version) break;
    db.exec(m.sql);
    markApplied.run(m.version);
  }
}

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyUpTo(24);
});

describe('migration v24 provider platform / provider_models / audit 配额', () => {
  it('model_providers.platform 列存在且新行默认 openai', () => {
    const cols = db.prepare("PRAGMA table_info('model_providers')").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('platform');
    db.prepare(
      "INSERT INTO model_providers (id, name, base_url, api_key_ref) VALUES ('p1', 'A', 'u', 'r')",
    ).run();
    const row = db.prepare('SELECT platform FROM model_providers WHERE id = ?').get('p1') as {
      platform: string;
    };
    expect(row.platform).toBe('openai');
  });

  it('platform CHECK 约束拒绝非法值', () => {
    expect(() => {
      db.prepare(
        "INSERT INTO model_providers (id, name, base_url, api_key_ref, platform) VALUES ('p2', 'B', 'u', 'r', 'azure')",
      ).run();
    }).toThrow();
  });

  it('v24 前已存在的 provider 行 platform 自动回填 openai', () => {
    const old = new Database(':memory:');
    old.pragma('foreign_keys = ON');
    // 只应用到 v23，插入无 platform 的旧行，再应用 v24
    const migrations = [...loadMigrations()].sort((a, b) => a.version - b.version);
    const v24 = migrations.find((m) => m.version === 24)!;
    old.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    for (const m of migrations) {
      if (m.version >= 24) break;
      old.exec(m.sql);
      old.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(m.version);
    }
    old.prepare(
      "INSERT INTO model_providers (id, name, base_url, api_key_ref) VALUES ('legacy', 'Old', 'u', 'r')",
    ).run();
    old.exec(v24.sql);
    const row = old.prepare('SELECT platform FROM model_providers WHERE id = ?').get('legacy') as {
      platform: string;
    };
    expect(row.platform).toBe('openai');
    old.close();
  });

  it('provider_models 表存在且 (provider_id, model_id) 双主键', () => {
    const cols = db.prepare("PRAGMA table_info('provider_models')").all() as Array<{
      name: string;
      pk: number;
      dflt_value: string | null;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['provider_id', 'model_id', 'enabled', 'added_at']));
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(pkCols).toEqual(['model_id', 'provider_id']);
    // enabled 默认 1
    const enabled = cols.find((c) => c.name === 'enabled')!;
    expect(enabled.dflt_value).toBe('1');
  });

  it('provider_models.enabled 默认 1（INSERT 省略时）', () => {
    db.prepare(
      "INSERT INTO model_providers (id, name, base_url, api_key_ref) VALUES ('p3', 'C', 'u', 'r')",
    ).run();
    db.prepare(
      "INSERT INTO provider_models (provider_id, model_id, added_at) VALUES ('p3', 'm1', 1000)",
    ).run();
    const row = db.prepare(
      'SELECT enabled FROM provider_models WHERE provider_id = ? AND model_id = ?',
    ).get('p3', 'm1') as { enabled: number };
    expect(row.enabled).toBe(1);
  });

  it('provider_models ON DELETE CASCADE（删 provider 级联清模型行）', () => {
    db.prepare(
      "INSERT INTO model_providers (id, name, base_url, api_key_ref) VALUES ('p4', 'D', 'u', 'r')",
    ).run();
    db.prepare(
      "INSERT INTO provider_models (provider_id, model_id, added_at) VALUES ('p4', 'm1', 1000)",
    ).run();
    db.prepare("DELETE FROM model_providers WHERE id = 'p4'").run();
    const row = db.prepare(
      'SELECT * FROM provider_models WHERE provider_id = ?',
    ).get('p4');
    expect(row).toBeUndefined();
  });

  it('workspaces.audit_quota_mb 列存在且默认 NULL（未配置）', () => {
    const cols = db.prepare("PRAGMA table_info('workspaces')").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('audit_quota_mb');
    db.prepare(
      `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES ('ws1', 'WS', '', '/tmp', 0, '@owner:s', '📁')`,
    ).run();
    const row = db.prepare('SELECT audit_quota_mb FROM workspaces WHERE id = ?').get('ws1') as {
      audit_quota_mb: number | null;
    };
    expect(row.audit_quota_mb).toBeNull();
  });
});
