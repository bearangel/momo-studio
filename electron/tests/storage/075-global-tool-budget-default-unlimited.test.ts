// electron/tests/storage/075-global-tool-budget-default-unlimited.test.ts
// migration 075 契约：
//   1. 旧默认痕迹 maxToolCalls=50 → -1（无限）
//   2. 显式自定义值（20 / 100 / 0 / -1）一律不动
//   3. 无 maxToolCalls 字段的 JSON 不被写入（json_extract NULL 不命中）
//   4. 无 global_settings 行不受影响（读侧走常量默认 -1）
//   5. 幂等：已升 -1 的行重放无变化（-1≠50 不再命中）
//   6. 全量 runMigrations 内注册（版本号连续）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { migration075 } from '../../src/main/storage/migrations/075_global_tool_budget_default_unlimited';

const tmpRoot = path.join(os.tmpdir(), `ap-mig075-test-${Date.now()}-${process.pid}`);

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

describe('migration 075：全局工具预算默认 50→-1 无限', () => {
  it('旧默认痕迹 50 升为 -1（migration 时点已有行）', () => {
    // runMigrations 已跑完 075——行插在其后需手动重放验证 migration 时点语义（同 052/054 惯例）
    putGlobal(JSON.stringify({ maxToolCalls: 50, auditQuotaMb: 100 }));
    getDb().exec(migration075.up);
    expect(readMaxToolCalls()).toBe(-1);
  });

  it('全量 runMigrations 内含 075（版本号连续注册）', () => {
    const versions = getDb()
      .prepare(`SELECT version FROM schema_migrations`)
      .all() as Array<{ version: number }>;
    expect(versions.map((v) => v.version)).toContain(75);
  });

  it.each([20, 100, 0, -1])('显式自定义值 %s 不动', (custom) => {
    putGlobal(JSON.stringify({ maxToolCalls: custom, auditQuotaMb: 100 }));
    getDb().exec(migration075.up);
    expect(readMaxToolCalls()).toBe(custom);
  });

  it('无 maxToolCalls 字段的 JSON 不被写入', () => {
    putGlobal(JSON.stringify({ auditQuotaMb: 100 }));
    getDb().exec(migration075.up);
    const row = getDb()
      .prepare(`SELECT value FROM kv_store WHERE key = 'global_settings'`)
      .get() as { value: string };
    expect(JSON.parse(row.value)).toEqual({ auditQuotaMb: 100 });
  });

  it('幂等：已升 -1 的行重放无变化', () => {
    putGlobal(JSON.stringify({ maxToolCalls: -1 }));
    getDb().exec(migration075.up);
    expect(readMaxToolCalls()).toBe(-1);
  });
});
