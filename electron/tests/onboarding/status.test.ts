// electron/tests/onboarding/status.test.ts
//
// onboarding 状态 kv 服务测试（spec 2026-10-10 §4）：
// 缺省 pending / completed / skipped 持久 / 畸形值容错回 pending / 幂等写。
// setup 模式照 electron/tests/agent/preset.test.ts（AP_USER_DATA_DIR + runMigrations）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  ONBOARDING_STATUS_KEY,
  readOnboardingStatus,
  markOnboardingDone,
} from '../../src/main/onboarding/status';

const tmpRoot = path.join(os.tmpdir(), `onboarding-status-${Date.now()}`);

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

describe('onboarding status kv', () => {
  it('无标记时缺省 pending', () => {
    expect(readOnboardingStatus()).toBe('pending');
  });

  it('markOnboardingDone(false) 写 completed 并持久', () => {
    markOnboardingDone(false);
    expect(
      getDb().prepare('SELECT value FROM kv_store WHERE key = ?').get(ONBOARDING_STATUS_KEY),
    ).toEqual({ value: '"completed"' });
    expect(readOnboardingStatus()).toBe('completed');
  });

  it('markOnboardingDone(true) 写 skipped', () => {
    markOnboardingDone(true);
    expect(readOnboardingStatus()).toBe('skipped');
  });

  it('markOnboardingDone 幂等（重复写不报错）', () => {
    markOnboardingDone(false);
    markOnboardingDone(false);
    expect(readOnboardingStatus()).toBe('completed');
  });

  it('畸形值容错回 pending（不抛错）', () => {
    getDb()
      .prepare(`INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
      .run(ONBOARDING_STATUS_KEY, 'not-json{');
    expect(readOnboardingStatus()).toBe('pending');
  });
});
