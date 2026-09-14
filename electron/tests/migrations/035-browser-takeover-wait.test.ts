// electron/tests/migrations/035-browser-takeover-wait.test.ts
//
// 迁移 v35 测试：workspace_settings 表加两 INTEGER 列（spec 2026-09-14 §4.4）。
//   agent_wait_ms INTEGER NOT NULL DEFAULT 60000
//   idle_auto_release_ms INTEGER NOT NULL DEFAULT 90000
//
// 三项断言：
//   1. 最新版库下两列齐全 + 默认值正确（PRAGMA + INSERT 省略两列回退 DEFAULT）
//   2. 升级路径：applyUpTo(34) + 插有 workspace_settings 旧行 → apply v35 →
//      存量行自动物化 DEFAULT（NOT NULL ADD COLUMN 在 SQLite 必带 DEFAULT，
//      旧行被回填——这是 NOT NULL 修饰的语义保证，测试锁这一保证）
//   3. 幂等：runMigrations 双跑第二次不炸（schema_migrations 已登记 35）
//
// fixture 模式混合：
//   - 路径 1+3 用真 AP_USER_DATA_DIR + runMigrations() 单例（沿用 034 同款）
//   - 路径 2 用独立 :memory: DB + applyUpTo(34) + 插旧行 + apply v35（沿用 024-settings
//     同款升级路径——避免改动既有库全局状态）

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { loadMigrations, type Migration } from '../../src/main/storage/migrations';

// =================================================================================
// 路径 1+3 fixture：真 runMigrations 单例（AP_USER_DATA_DIR 注入临时目录）
// =================================================================================

const tmpRoot = path.join(os.tmpdir(), `ap-mig-035-${Date.now()}`);
let db: DB;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  db = getDb();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function insertWorkspace(id: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, 'WS', '', '/tmp', 0, '@owner:s', '📁')`,
  ).run(id);
}

describe('migration v35 workspace_settings 接管等待两列（spec 2026-09-14 §4.4）', () => {
  it('workspace_settings 表含 agent_wait_ms / idle_auto_release_ms 两列', () => {
    const cols = db.prepare("PRAGMA table_info('workspace_settings')").all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['workspace_id', 'agent_wait_ms', 'idle_auto_release_ms']),
    );
  });

  it('两列默认值 60000 / 90000（INSERT 省略两列回退 DEFAULT）', () => {
    insertWorkspace('ws-dft');
    db.prepare("INSERT INTO workspace_settings (workspace_id) VALUES ('ws-dft')").run();
    const row = db.prepare('SELECT * FROM workspace_settings WHERE workspace_id = ?').get(
      'ws-dft',
    ) as Record<string, unknown>;
    expect(row.agent_wait_ms).toBe(60_000);
    expect(row.idle_auto_release_ms).toBe(90_000);
  });

  it('可写入任意合法毫秒值（含 0 = 关闭语义）与读回一致', () => {
    insertWorkspace('ws-zero');
    db.prepare(
      "INSERT INTO workspace_settings (workspace_id, agent_wait_ms, idle_auto_release_ms) VALUES (?, ?, ?)",
    ).run('ws-zero', 0, 120_000);
    const row = db.prepare('SELECT agent_wait_ms, idle_auto_release_ms FROM workspace_settings WHERE workspace_id = ?').get(
      'ws-zero',
    ) as Record<string, unknown>;
    expect(row.agent_wait_ms).toBe(0);
    expect(row.idle_auto_release_ms).toBe(120_000);
  });

  it('幂等：双跑 runMigrations 第二次为 no-op 不炸，版本已登记', () => {
    // beforeEach 已跑第一次；此处双跑验证幂等（brief 指定模式，与 034 同款）
    expect(() => runMigrations()).not.toThrow();
    const versions = (
      db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]
    ).map((r) => r.version);
    expect(versions).toContain(35);
    // 两列仍在（双跑未破坏 schema）
    const cols = db.prepare("PRAGMA table_info('workspace_settings')").all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['agent_wait_ms', 'idle_auto_release_ms']),
    );
  });
});

// =================================================================================
// 路径 2 fixture：独立 :memory: DB（升级路径——避免污染上面单例 + 复刻真实老库场景）
// =================================================================================

let oldDb: DB;

function applyUpTo(version: number, target: DB): void {
  target.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  const markApplied = target.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)',
  );
  // 读已应用版本——重复调用 applyUpTo 时跳过已跑的 SQL（部分 v SQL 用 ALTER/CREATE，
  // 重跑报 duplicate column name，仿生产 runMigrations 的 schema_migrations 跳过语义）
  const applied = new Set(
    (target.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const migrations = [...loadMigrations()].sort((a: Migration, b: Migration) => a.version - b.version);
  for (const m of migrations) {
    if (m.version > version) break;
    if (applied.has(m.version)) continue;
    target.exec(m.sql);
    markApplied.run(m.version);
  }
}

describe('migration v35 升级路径：v34 → v35', () => {
  beforeAll(() => {
    oldDb = new Database(':memory:');
    oldDb.pragma('foreign_keys = ON');
    // 只 apply 到 v34（模拟「升级前」的 v2.7 McpBrowser 用户库）
    applyUpTo(34, oldDb);
    // 在 v34 时点插入工作区与旧 settings 行（不含 agent_wait_ms / idle_auto_release_ms 列）
    oldDb.prepare(
      `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES ('legacy-ws', 'Legacy', '', '/tmp/legacy', 0, '@owner:s', '📁')`,
    ).run();
    oldDb.prepare(
      "INSERT INTO workspace_settings (workspace_id, trust_browser, browser_sidebar_width) VALUES ('legacy-ws', 'always', 480)",
    ).run();
    // 应用 v35（沿用 applyUpTo 共用分支——既跑 SQL 也登记版本，单一真相源）
    applyUpTo(35, oldDb);
  });

  afterAll(() => {
    oldDb.close();
  });

  it('存量 workspace_settings 行自动物化两列 DEFAULT 60000 / 90000（NOT NULL 语义保证）', () => {
    const row = oldDb
      .prepare('SELECT agent_wait_ms, idle_auto_release_ms FROM workspace_settings WHERE workspace_id = ?')
      .get('legacy-ws') as Record<string, unknown>;
    expect(row.agent_wait_ms).toBe(60_000);
    expect(row.idle_auto_release_ms).toBe(90_000);
    // 既有列未被 v35 破坏（升级回写非破坏）
    const full = oldDb.prepare('SELECT trust_browser, browser_sidebar_width FROM workspace_settings WHERE workspace_id = ?').get(
      'legacy-ws',
    ) as Record<string, unknown>;
    expect(full.trust_browser).toBe('always');
    expect(full.browser_sidebar_width).toBe(480);
  });

  it('升级后 schema_migrations 同时记录 34 与 35（顺序登记无丢失）', () => {
    const versions = (
      oldDb.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
        version: number;
      }[]
    ).map((r) => r.version);
    expect(versions).toContain(34);
    expect(versions).toContain(35);
  });

  it('升级后新写入可显式覆盖两列（含 0 与 >0）', () => {
    // workspace_settings.workspace_id FK → workspaces.id，必须先插 ws
    oldDb.prepare(
      `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES ('new-ws', 'New', '', '/tmp/new', 0, '@owner:s', '📁')`,
    ).run();
    oldDb.prepare(
      "INSERT INTO workspace_settings (workspace_id, agent_wait_ms, idle_auto_release_ms) VALUES ('new-ws', 0, 0)",
    ).run();
    const row = oldDb
      .prepare('SELECT agent_wait_ms, idle_auto_release_ms FROM workspace_settings WHERE workspace_id = ?')
      .get('new-ws') as Record<string, unknown>;
    expect(row.agent_wait_ms).toBe(0);
    expect(row.idle_auto_release_ms).toBe(0);
  });
});
