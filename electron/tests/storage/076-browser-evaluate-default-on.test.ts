// electron/tests/storage/076-browser-evaluate-default-on.test.ts
// migration 076 契约：
//   1. 存量行 browser_evaluate_enabled=0 → 1（旧默认烤入痕迹全翻）
//   2. 已为 1 的行不动（幂等）
//   3. 无行工作空间不受影响（读侧走 DEFAULT_BROWSER_SETTINGS.evaluateEnabled=true）
//   4. 同行其他列（trust / 黑白名单 / 侧栏）不被破坏
//   5. 全量 runMigrations 内注册（版本号连续）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { migration076 } from '../../src/main/storage/migrations/076_browser_evaluate_default_on';

const tmpRoot = path.join(os.tmpdir(), `ap-mig076-test-${Date.now()}-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

interface WsRow {
  workspace_id: string;
  trust_browser: string;
  browser_evaluate_enabled: number;
  browser_domain_blacklist: string;
  browser_sidebar_collapsed: number;
}

function putWs(id: string, evaluate: number): void {
  // workspace_id 外键依赖：先落 workspaces 行（幂等）
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO workspaces
         (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES (?, 'WS', '', '/tmp', 0, '@owner:s', '📁')`,
    )
    .run(id);
  getDb()
    .prepare(
      `INSERT INTO workspace_settings (
         workspace_id, trust_browser, browser_evaluate_enabled,
         browser_domain_blacklist, browser_domain_whitelist,
         browser_sidebar_collapsed, browser_sidebar_width,
         agent_wait_ms, idle_auto_release_ms
       ) VALUES (?, 'ask', ?, '[]', '[]', 1, 380, 120000, 90000)`,
    )
    .run(id, evaluate);
}

function readWs(id: string): WsRow {
  return getDb()
    .prepare(`SELECT * FROM workspace_settings WHERE workspace_id = ?`)
    .get(id) as WsRow;
}

describe('migration 076：浏览器页面脚本执行默认 0→1', () => {
  it('存量 0 行全翻 1，同行其他列不破坏', () => {
    putWs('ws-a', 0);
    getDb().exec(migration076.up);
    const row = readWs('ws-a');
    expect(row.browser_evaluate_enabled).toBe(1);
    expect(row.trust_browser).toBe('ask');
    expect(row.browser_domain_blacklist).toBe('[]');
    expect(row.browser_sidebar_collapsed).toBe(1);
  });

  it('已为 1 的行不动（幂等）', () => {
    putWs('ws-b', 1);
    getDb().exec(migration076.up);
    expect(readWs('ws-b').browser_evaluate_enabled).toBe(1);
  });

  it('多行全翻：0 与 1 混合库', () => {
    putWs('ws-c1', 0);
    putWs('ws-c2', 0);
    putWs('ws-c3', 1);
    getDb().exec(migration076.up);
    expect(readWs('ws-c1').browser_evaluate_enabled).toBe(1);
    expect(readWs('ws-c2').browser_evaluate_enabled).toBe(1);
    expect(readWs('ws-c3').browser_evaluate_enabled).toBe(1);
  });

  it('全量 runMigrations 内含 076（版本号连续注册）', () => {
    const versions = getDb()
      .prepare(`SELECT version FROM schema_migrations`)
      .all() as Array<{ version: number }>;
    expect(versions.map((v) => v.version)).toContain(76);
  });
});
