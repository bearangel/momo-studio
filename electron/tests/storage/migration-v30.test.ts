// electron/tests/storage/migration-v30.test.ts
//
// 迁移 v30 测试：压缩改造数据层（spec 2026-09-09 §2.1）。
//
//   1. provider_models.context_window：用户手动覆盖的上下文窗口列，
//      NULL=未知（走内置目录）。可写读 + 缺省 NULL。
//   2. session_compactions：会话压缩摘要表（每会话单行 upsert），
//      session 级联删除。与 session_summaries（extraction 背景摘要）
//      语义分离——本表 covered_until 驱动历史收缩。
//
// 模式参照 migration-v28.test.ts：内存库升到 v29 → 注入 fixture → 应用 v30。

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

const V29 = 29;

function applyUpTo(db: DB, version: number): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  const markApplied = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
  for (const m of loadMigrations()) {
    if (m.version > version) break;
    db.exec(m.sql);
    markApplied.run(m.version);
  }
}

function applyRemaining(db: DB, afterVersion: number): void {
  const markApplied = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
  for (const m of loadMigrations()) {
    if (m.version <= afterVersion) continue;
    db.exec(m.sql);
    markApplied.run(m.version);
  }
}

/** 种一个供应商（provider_models 的 FK 目标） */
function seedProvider(db: DB, id: string): void {
  db.prepare(
    `INSERT INTO model_providers
       (id, name, base_url, api_key_ref, default_model, is_default, platform)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'T', 'https://api.test.com', `provider.${id}.api_key`, null, 0, 'openai');
}

/** 种一个 workspace + session（session_compactions 的 FK 链；workspace 幂等） */
function seedSession(db: DB, wsId: string, sessionId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, 'WS', '', '/tmp', 0, '@owner:s', '📁')`,
  ).run(wsId);
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, title, kind, created_at, updated_at)
     VALUES (?, ?, 't', 'chat', 1000, 1000)`,
  ).run(sessionId, wsId);
}

describe('migration v30：压缩改造数据层', () => {
  it('provider_models.context_window 可写读；缺省为 NULL', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V29);

    seedProvider(db, 'pid-1');
    // 不带 context_window 插入（v29 时代写法）→ v30 后列存在且缺省 NULL
    db.prepare(
      `INSERT INTO provider_models (provider_id, model_id, enabled, added_at)
       VALUES ('pid-1', 'm-default', 1, 1000)`,
    ).run();

    applyRemaining(db, V29);

    const defaulted = db
      .prepare('SELECT context_window FROM provider_models WHERE model_id = ?')
      .get('m-default') as { context_window: number | null };
    expect(defaulted.context_window).toBeNull();

    // 写入用户覆盖值后可读回
    db.prepare('UPDATE provider_models SET context_window = ? WHERE model_id = ?')
      .run(131072, 'm-default');
    const updated = db
      .prepare('SELECT context_window FROM provider_models WHERE model_id = ?')
      .get('m-default') as { context_window: number | null };
    expect(updated.context_window).toBe(131072);

    // v30 后新插入行可直接带 context_window
    db.prepare(
      `INSERT INTO provider_models (provider_id, model_id, enabled, added_at, context_window)
       VALUES ('pid-1', 'm-with-window', 1, 1001, 200000)`,
    ).run();
    const withWindow = db
      .prepare('SELECT context_window FROM provider_models WHERE model_id = ?')
      .get('m-with-window') as { context_window: number | null };
    expect(withWindow.context_window).toBe(200000);
    db.close();
  });

  it('session_compactions 建表：行可写读 + 同会话 upsert 覆盖', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V29);

    seedSession(db, 'ws-1', 'sess-1');
    applyRemaining(db, V29);

    const insert = db.prepare(
      `INSERT INTO session_compactions (session_id, summary, covered_until, updated_at)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run('sess-1', '摘要 v1', 1000, 1000);
    // upsert 语义：每会话单行，重复压缩覆盖（应用层 INSERT OR REPLACE）
    db.prepare(
      `INSERT OR REPLACE INTO session_compactions (session_id, summary, covered_until, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run('sess-1', '摘要 v2（滚动合并）', 2000, 2001);

    const rows = db
      .prepare('SELECT * FROM session_compactions WHERE session_id = ?')
      .all('sess-1') as Array<{
      session_id: string;
      summary: string;
      covered_until: number;
      updated_at: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe('摘要 v2（滚动合并）');
    expect(rows[0]!.covered_until).toBe(2000);
    db.close();
  });

  it('session 删除时 session_compactions 级联清理（ON DELETE CASCADE）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V29);

    seedSession(db, 'ws-1', 'sess-1');
    seedSession(db, 'ws-1', 'sess-2');
    applyRemaining(db, V29);

    db.prepare(
      `INSERT INTO session_compactions (session_id, summary, covered_until, updated_at)
       VALUES ('sess-1', 's1', 1000, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO session_compactions (session_id, summary, covered_until, updated_at)
       VALUES ('sess-2', 's2', 1000, 1000)`,
    ).run();

    db.prepare('DELETE FROM sessions WHERE id = ?').run('sess-1');

    const remaining = db
      .prepare('SELECT session_id FROM session_compactions')
      .all() as Array<{ session_id: string }>;
    expect(remaining.map((r) => r.session_id)).toEqual(['sess-2']);
    db.close();
  });

  it('空库直接升到最新：迁移不炸', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const latest = Math.max(...loadMigrations().map((m) => m.version));
    applyUpTo(db, latest);
    db.close();
  });
});
