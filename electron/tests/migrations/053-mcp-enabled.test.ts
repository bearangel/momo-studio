// electron/tests/migrations/053-mcp-enabled.test.ts
//
// 组⑤：migration 053（mcp_definitions 加 enabled 列）测试。
//   - up：PRAGMA table_info 含 enabled；旧行不被破坏（config_schema 仍在），
//     新列 NOT NULL DEFAULT 1（存量全启用，零行为变化）
//   - down：真 DROP COLUMN——列消失、行保留（040 起的 down 惯例）
//   - down → up 往返：re-ADD 后列可用，写入/回读 roundtrip 正常
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migration053 } from '../../src/main/storage/migrations/053_mcp_enabled';

/** 建一个含 mcp_definitions 旧 schema（052 后、053 前）的内存库——config_schema 列已在 */
function buildLegacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE mcp_definitions (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      version TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'stdio',
      command TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '[]',
      env TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'marketplace',
      installed_at TEXT NOT NULL DEFAULT (datetime('now')),
      url TEXT,
      headers_json TEXT,
      cwd TEXT,
      config_schema TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO mcp_definitions (id, name, version, command) VALUES ('a', 'old', '1.0.0', 'npx foo');
  `);
  return db;
}

function columns(db: Database.Database): string[] {
  return (
    db.prepare("PRAGMA table_info('mcp_definitions')").all() as { name: string }[]
  ).map((c) => c.name);
}

describe('migration 053 mcp enabled', () => {
  it('up 加 enabled 列且旧行兜底 1（NOT NULL DEFAULT，存量全启用）', () => {
    const db = buildLegacyDb();
    db.exec(migration053.up);
    expect(columns(db)).toContain('enabled');
    const row = db
      .prepare('SELECT name, config_schema, enabled FROM mcp_definitions')
      .get() as { name: string; config_schema: string; enabled: number };
    expect(row.name).toBe('old');
    expect(row.config_schema).toBe('{}');
    expect(row.enabled).toBe(1);
  });

  it('down 真 DROP COLUMN——列消失、行保留', () => {
    const db = buildLegacyDb();
    db.exec(migration053.up);
    db.exec(migration053.down);
    expect(columns(db)).not.toContain('enabled');
    expect((db.prepare('SELECT COUNT(*) AS n FROM mcp_definitions').get() as { n: number }).n).toBe(1);
  });

  it('down → up 往返：re-ADD 后写入/回读 roundtrip 正常', () => {
    const db = buildLegacyDb();
    db.exec(migration053.up);
    db.exec(migration053.down);
    db.exec(migration053.up);
    db.prepare('UPDATE mcp_definitions SET enabled = 0 WHERE name = ?').run('old');
    const row = db
      .prepare('SELECT enabled FROM mcp_definitions WHERE name = ?')
      .get('old') as { enabled: number };
    expect(row.enabled).toBe(0);
  });
});
