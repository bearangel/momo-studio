// electron/tests/migrations/040-mcp-config-schema.test.ts
//
// P2.2 Task 1：migration 040（mcp_definitions 加 config_schema 列）测试。
//   - up：PRAGMA table_info 含 config_schema；旧行不被破坏（039 的 cwd 仍 NULL），
//     新列 NOT NULL DEFAULT '{}' 兜底
//   - down：真 DROP COLUMN——列消失、行保留（对 039 no-op down 惯例的刻意改进，
//     Task 0 冒烟已证本机 SQLite 支持 DROP COLUMN）
//   - down → up 往返：re-ADD 后列可用，写入/回读 roundtrip 正常
//   - 幂等拒绝重复应用（schema_migrations 单次保证的行为锚）
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migration040 } from '../../src/main/storage/migrations/040_p22_mcp_config_schema';

/** 建一个含 mcp_definitions 旧 schema（039 后、040 前）的内存库——cwd 列已在 */
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
      cwd TEXT
    );
    INSERT INTO mcp_definitions (id, name, version, command) VALUES ('a', 'old', '1.0.0', 'npx foo');
  `);
  return db;
}

/** mcp_definitions 当前列名集合 */
function columns(db: Database.Database): string[] {
  return (
    db.prepare("PRAGMA table_info('mcp_definitions')").all() as { name: string }[]
  ).map((c) => c.name);
}

describe('migration 040 mcp config_schema', () => {
  it('up 加 config_schema 列且旧行兜底 {}（NOT NULL DEFAULT）', () => {
    const db = buildLegacyDb();
    db.exec(migration040.up);
    expect(columns(db)).toContain('config_schema');
    const row = db
      .prepare('SELECT name, cwd, config_schema FROM mcp_definitions')
      .get() as { name: string; cwd: string | null; config_schema: string };
    expect(row.name).toBe('old');
    // 旧行不被 up 破坏：039 的 cwd 仍 NULL；新列兜底 '{}'（读取侧视为无 schema）
    expect(row.cwd).toBeNull();
    expect(row.config_schema).toBe('{}');
  });

  it('down 真 DROP COLUMN：列消失、行与既有列不受影响', () => {
    const db = buildLegacyDb();
    db.exec(migration040.up);
    db.exec(migration040.down);
    expect(columns(db)).not.toContain('config_schema');
    // 相邻列与数据保留
    expect(columns(db)).toContain('cwd');
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM mcp_definitions')
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('down → up 往返：re-ADD 后新行走 DEFAULT、写入回读正常（Task 0 冒烟语义回归锁）', () => {
    const db = buildLegacyDb();
    db.exec(migration040.up);
    db.exec(migration040.down);
    db.exec(migration040.up);
    expect(columns(db)).toContain('config_schema');

    // 回滚重升后 INSERT 不给 config_schema 列 → DEFAULT '{}' 兜底
    db.prepare(
      "INSERT INTO mcp_definitions (id, name, version, command) VALUES ('b', 'new', '1.0.0', 'npx bar')",
    ).run();
    const rows = db
      .prepare('SELECT name, config_schema FROM mcp_definitions ORDER BY name')
      .all() as Array<{ name: string; config_schema: string }>;
    expect(rows).toEqual([
      { name: 'new', config_schema: '{}' },
      { name: 'old', config_schema: '{}' },
    ]);

    // 显式写入 schema 回读 roundtrip
    db.prepare(
      "UPDATE mcp_definitions SET config_schema = '{\"required\":[\"k\"]}' WHERE name = 'new'",
    ).run();
    const updated = db
      .prepare("SELECT config_schema FROM mcp_definitions WHERE name = 'new'")
      .get() as { config_schema: string };
    expect(updated.config_schema).toBe('{"required":["k"]}');
  });

  it('幂等拒绝重复应用（SQLite ALTER 重复跑报错——验证第二次 exec 抛错）', () => {
    const db = buildLegacyDb();
    db.exec(migration040.up);
    expect(() => db.exec(migration040.up)).toThrow();
  });
});
