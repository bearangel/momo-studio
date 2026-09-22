// electron/tests/migrations/038-mcp-remote-transport.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migration038 } from '../../src/main/storage/migrations/038_p2_mcp_remote_transport';

/** 建一个含 mcp_definitions 旧 schema（v1.6 后、038 前）的内存库 */
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
      installed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO mcp_definitions (id, name, version, command) VALUES ('a', 'old', '1.0.0', 'npx foo');
  `);
  return db;
}

describe('migration 038 mcp remote transport', () => {
  it('up 加 url / headers_json 两列且保留旧行', () => {
    const db = buildLegacyDb();
    db.exec(migration038.up);
    const cols = (db.prepare("PRAGMA table_info('mcp_definitions')").all() as { name: string }[])
      .map((c) => c.name);
    expect(cols).toContain('url');
    expect(cols).toContain('headers_json');
    const row = db.prepare('SELECT name, url, headers_json FROM mcp_definitions').get() as {
      name: string; url: string | null; headers_json: string | null;
    };
    expect(row.name).toBe('old');
    expect(row.url).toBeNull();
    expect(row.headers_json).toBeNull();
  });
  it('幂等拒绝重复应用（SQLite ALTER 重复跑报错——验证第二次 exec 抛错）', () => {
    const db = buildLegacyDb();
    db.exec(migration038.up);
    expect(() => db.exec(migration038.up)).toThrow();
  });
});
