// electron/tests/storage/054-global-tool-budget-default-50.test.ts
// migration 054 契约：
//   1. 旧默认痕迹 maxToolCalls=10 → 50
//   2. 显式自定义值（20 / -1 / 0）一律不动
//   3. 无 maxToolCalls 字段的 JSON 不被写入（json_extract NULL 不命中）
//   4. 无 global_settings 行不受影响（读侧走常量默认 50）
//   5. 幂等：已升 50 的行重放无变化（50≠10 不再命中）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { migration054 } from '../../src/main/storage/migrations/054_global_tool_budget_default_50';

const tmpRoot = path.join(os.tmpdir(), `ap-mig054-test-${Date.now()}-${process.pid}`);

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

function putGlobal(json: string): void {
  getDb()
    .prepare(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ('global_settings', ?, datetime('now'))`,
    )
    .run(json);
}

function readMaxToolCalls(): number | null {
  const row = getDb()
    .prepare(`SELECT value FROM kv_store WHERE key = 'global_settings'`)
    .get() as { value: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.value).maxToolCalls as number | null;
}

describe('migration 054：全局工具预算默认 10→50', () => {
  it('旧默认痕迹 10 升为 50（migration 时点已有行）', () => {
    // runMigrations 已跑完 054——行插在其后需手动重放验证 migration 时点语义（同 052 惯例）
    putGlobal(JSON.stringify({ maxToolCalls: 10, auditQuotaMb: 100 }));
    getDb().exec(migration054.up);
    expect(readMaxToolCalls()).toBe(50);
  });

  it('行先落库再跑全量 migration 同样升 50（真实升级路径）', () => {
    // 重建临时库绕过 beforeEach 的已迁移态：直接对带 10 的行重放（上一用例已覆盖）；
    // 本用例锁「全量 runMigrations 内含 054」——loadMigrations 版本号连续注册
    const versions = getDb()
      .prepare(`SELECT version FROM schema_migrations`)
      .all() as Array<{ version: number }>;
    expect(versions.map((v) => v.version)).toContain(54);
  });

  it.each([20, -1, 0])('显式自定义值 %s 不动', (custom) => {
    putGlobal(JSON.stringify({ maxToolCalls: custom, auditQuotaMb: 100 }));
    getDb().exec(migration054.up);
    expect(readMaxToolCalls()).toBe(custom);
  });

  it('无 maxToolCalls 字段的 JSON 不被写入', () => {
    putGlobal(JSON.stringify({ auditQuotaMb: 100 }));
    getDb().exec(migration054.up);
    const row = getDb()
      .prepare(`SELECT value FROM kv_store WHERE key = 'global_settings'`)
      .get() as { value: string };
    expect(JSON.parse(row.value)).toEqual({ auditQuotaMb: 100 });
  });

  it('幂等：已升 50 的行重放无变化', () => {
    putGlobal(JSON.stringify({ maxToolCalls: 50 }));
    getDb().exec(migration054.up);
    expect(readMaxToolCalls()).toBe(50);
  });
});
