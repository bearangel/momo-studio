// electron/tests/migrations/039-mcp-cwd.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migration039 } from '../../src/main/storage/migrations/039_p21_mcp_bundle_cwd';

/** 建一个含 mcp_definitions 旧 schema（038 后、039 前）的内存库——url/headers_json 两列已在 */
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
      headers_json TEXT
    );
    INSERT INTO mcp_definitions (id, name, version, command) VALUES ('a', 'old', '1.0.0', 'npx foo');
  `);
  return db;
}

describe('migration 039 mcp bundle cwd', () => {
  it('up 加 cwd 列且保留旧行', () => {
    const db = buildLegacyDb();
    db.exec(migration039.up);
    const cols = (db.prepare("PRAGMA table_info('mcp_definitions')").all() as { name: string }[])
      .map((c) => c.name);
    expect(cols).toContain('cwd');
    const row = db.prepare('SELECT name, url, headers_json, cwd FROM mcp_definitions').get() as {
      name: string; url: string | null; headers_json: string | null; cwd: string | null;
    };
    expect(row.name).toBe('old');
    // 旧行 cwd 为 NULL（缺省 = 不改 spawn 工作目录），038 两列不受影响
    expect(row.cwd).toBeNull();
    expect(row.url).toBeNull();
    expect(row.headers_json).toBeNull();
  });
  it('幂等拒绝重复应用（SQLite ALTER 重复跑报错——验证第二次 exec 抛错）', () => {
    const db = buildLegacyDb();
    db.exec(migration039.up);
    expect(() => db.exec(migration039.up)).toThrow();
  });
});
