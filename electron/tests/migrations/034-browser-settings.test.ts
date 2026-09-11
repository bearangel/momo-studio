// electron/tests/migrations/034-browser-settings.test.ts
//
// 迁移 v34 测试：workspace_settings 表六列（spec 2026-09-11 §9）。
//
// 版本号与建表形态的两处保真修正（spec 草稿 vs 现实）：
//   1. spec §9 写「migration v32」，但 032/033 已被 v2.3（apply_patch）/ v2.5
//      （change journal）占用——runMigrations 以 schema_migrations.version 为
//      跳过依据（db.ts `applied.has(m.version)`），重复版本号会让本迁移在所有
//      库上被静默跳过，故浏览器迁移落 034。
//   2. spec 的 ALTER TABLE ADD COLUMN 预设 workspace_settings 已存在，实际
//      v1→v33 从未建过该表（全库无此表名），故 034 为 CREATE TABLE——六列的
//      列名 / 类型 / NOT NULL / DEFAULT 与 spec §9 逐字一致。
//
// fixture 照 tests/journal/store.test.ts：AP_USER_DATA_DIR 注入临时目录 +
// runMigrations() 真实建库；幂等直接双跑生产路径 runMigrations（brief 指定）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Database as DB } from 'better-sqlite3';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `ap-mig-034-${Date.now()}`);

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

/** 024-settings.test.ts 同款 workspaces 插入列清单 */
function insertWorkspace(id: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, 'WS', '', '/tmp', 0, '@owner:s', '📁')`,
  ).run(id);
}

describe('migration v34 workspace_settings 六列（spec §9）', () => {
  it('workspace_settings 表存在且 workspace_id + 六列齐全', () => {
    const cols = db.prepare("PRAGMA table_info('workspace_settings')").all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'workspace_id',
        'trust_browser',
        'browser_evaluate_enabled',
        'browser_domain_blacklist',
        'browser_domain_whitelist',
        'browser_sidebar_collapsed',
        'browser_sidebar_width',
      ]),
    );
  });

  it('六列默认值 ask / 0 / [] / [] / 0 / 380（INSERT 省略六列的行为验证）', () => {
    insertWorkspace('ws-dft');
    db.prepare("INSERT INTO workspace_settings (workspace_id) VALUES ('ws-dft')").run();
    const row = db.prepare('SELECT * FROM workspace_settings WHERE workspace_id = ?').get(
      'ws-dft',
    ) as Record<string, unknown>;
    expect(row.trust_browser).toBe('ask');
    expect(row.browser_evaluate_enabled).toBe(0);
    expect(row.browser_domain_blacklist).toBe('[]');
    expect(row.browser_domain_whitelist).toBe('[]');
    expect(row.browser_sidebar_collapsed).toBe(0);
    expect(row.browser_sidebar_width).toBe(380);
  });

  it('幂等：双跑 runMigrations 第二次为 no-op 不炸，版本已登记', () => {
    // beforeEach 已跑第一次；此处双跑验证幂等（brief 指定模式）
    expect(() => runMigrations()).not.toThrow();
    const versions = (
      db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]
    ).map((r) => r.version);
    expect(versions).toContain(34);
    // 表结构仍在（双跑未破坏 schema）
    const cols = db.prepare("PRAGMA table_info('workspace_settings')").all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain('trust_browser');
  });

  it('workspace_id 主键 + 外键级联删除（删 workspace 清 settings 行）', () => {
    insertWorkspace('ws-fk');
    db.prepare("INSERT INTO workspace_settings (workspace_id) VALUES ('ws-fk')").run();
    // 主键：同 workspace_id 二次 INSERT 冲突
    expect(() => {
      db.prepare("INSERT INTO workspace_settings (workspace_id) VALUES ('ws-fk')").run();
    }).toThrow();
    db.prepare("DELETE FROM workspaces WHERE id = 'ws-fk'").run();
    expect(
      db.prepare('SELECT * FROM workspace_settings WHERE workspace_id = ?').get('ws-fk'),
    ).toBeUndefined();
  });
});
