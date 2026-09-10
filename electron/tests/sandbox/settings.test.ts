// electron/tests/sandbox/settings.test.ts
//
// 沙箱设置读取测试：testOverride 钩子优先于 DB；置 null 后回退 GlobalSettings。
// db fixture 复用 tests/settings/crud.test.ts 模式（AP_USER_DATA_DIR 临时目录）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { updateGlobalSettings } from '../../src/main/settings/crud';
import {
  getSandboxSettings,
  __setSandboxSettingsForTest,
} from '../../src/main/sandbox/settings';

const tmpRoot = path.join(os.tmpdir(), `ap-sandbox-settings-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});
afterEach(() => {
  // 清除 override，避免泄漏到同文件后续用例
  __setSandboxSettingsForTest(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('sandbox/settings', () => {
  it('testOverride 注入后优先生效（无需 DB 值）', () => {
    __setSandboxSettingsForTest({ mode: 'permissive', networkEnabled: true });
    expect(getSandboxSettings()).toEqual({ mode: 'permissive', networkEnabled: true });
  });

  it('override 置 null 后走 DB，缺省 strict / false', () => {
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings()).toEqual({ mode: 'strict', networkEnabled: false });
  });

  it('override 置 null 后 DB 写入的 permissive/true 真实读出（锁 DB 通路非硬编码）', () => {
    updateGlobalSettings({ sandboxMode: 'permissive', sandboxNetwork: true });
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings()).toEqual({ mode: 'permissive', networkEnabled: true });
  });

  it('DB 里非法枚举值收敛为 strict（sandboxMode 只认 permissive）', () => {
    // 直接写非法形状进 kv_store，模拟旧库/手工改库
    getDb()
      .prepare(
        `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run('global_settings', JSON.stringify({ sandboxMode: 'yolo', sandboxNetwork: 'yes' }));
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings()).toEqual({ mode: 'strict', networkEnabled: false });
  });
});
