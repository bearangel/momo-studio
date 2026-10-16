// electron/tests/plugin/hook-calls-quota.test.ts
//
// T8 M3：hook_calls 配额——超限删最旧（滞回 95%）+ 观察者写入计数触发。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  enforceHookCallsQuota,
  HOOK_CALLS_MAX_ROWS,
  HOOK_CALLS_ENFORCE_INTERVAL,
} from '../../src/main/audit/quota';
import { wireHookBridgeAudit } from '../../src/main/plugin/hook-bridge-main';
import { HookBus } from '../../src/main/plugin/hook-bus';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-hquota-'));

function seedRows(n: number, startId = 1): void {
  const ins = getDb().prepare(
    `INSERT INTO hook_calls (id, plugin_id, event, matcher, decision, duration_ms, success, timestamp)
     VALUES (?, 'p', 'appReady', NULL, NULL, 1, 1, ?)`,
  );
  const ts = Date.now();
  const tx = getDb().transaction((count: number, base: number) => {
    for (let i = 0; i < count; i++) ins.run(`row-${base + i}`, ts + i);
  });
  tx(n, startId);
}

function countRows(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM hook_calls`).get() as { n: number }).n;
}

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

describe('enforceHookCallsQuota', () => {
  it('未超限 → 不删', () => {
    seedRows(100);
    expect(enforceHookCallsQuota()).toBe(0);
    expect(countRows()).toBe(100);
  });

  it('超限 → 删至 95%（滞回；批量粒度内过冲，与 audit 配额同语义），最旧先删', () => {
    seedRows(HOOK_CALLS_MAX_ROWS + 3000);
    const before = countRows();
    const deleted = enforceHookCallsQuota();
    const target = Math.floor(HOOK_CALLS_MAX_ROWS * 0.95);
    // while 循环按 5000 批删——终点落在 (target-5000, target]
    expect(countRows()).toBeLessThanOrEqual(target);
    expect(countRows()).toBeGreaterThan(target - 5000);
    expect(deleted).toBe(before - countRows());
    // 最旧的行已不在
    const oldest = getDb().prepare(`SELECT COUNT(*) AS n FROM hook_calls WHERE id = 'row-1'`).get() as { n: number };
    expect(oldest.n).toBe(0);
  });

  it('巡检间隔常量合理（500——照 AUDIT_ENFORCE_INTERVAL 模式）', () => {
    expect(HOOK_CALLS_ENFORCE_INTERVAL).toBe(500);
  });
});

describe('wireHookBridgeAudit 计数触发', () => {
  it('观察者写入路径正常（500 条 = 一个巡检间隔走完不炸；触发面为机械守卫）', async () => {
    const bus = new HookBus();
    wireHookBridgeAudit(bus);
    for (let i = 0; i < HOOK_CALLS_ENFORCE_INTERVAL; i++) {
      bus.register({ pluginId: `p${i}`, event: 'appReady', modulePath: `m${i}`, handler: async () => null });
    }
    bus.dispatch('appReady', {});
    await new Promise((r) => setTimeout(r, 50));
    expect(countRows()).toBe(HOOK_CALLS_ENFORCE_INTERVAL);
  });
});
