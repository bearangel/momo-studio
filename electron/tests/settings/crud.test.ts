// electron/tests/settings/crud.test.ts
//
// GlobalSettings 沙箱字段测试（v2.4 Task 1）。db fixture 沿用 tests/settings/
// 既有模式：process.env.AP_USER_DATA_DIR 指向临时目录 + runMigrations/closeDb 复位单例。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { getGlobalSettings, updateGlobalSettings } from '../../src/main/settings/crud';

const tmpRoot = path.join(os.tmpdir(), `ap-crud-test-${Date.now()}`);

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

describe('GlobalSettings 沙箱字段（v2.4）', () => {
  it('缺省 sandboxMode=strict / sandboxNetwork=false', () => {
    const g = getGlobalSettings();
    expect(g.sandboxMode).toBe('strict');
    expect(g.sandboxNetwork).toBe(false);
  });
  it('updateGlobalSettings 部分更新沙箱字段', () => {
    updateGlobalSettings({ sandboxMode: 'permissive', sandboxNetwork: true });
    const g = getGlobalSettings();
    expect(g.sandboxMode).toBe('permissive');
    expect(g.sandboxNetwork).toBe(true);
  });
});

describe('GlobalSettings 变更账本字段（v2.5 Task 6）', () => {
  it('缺省 journalQuotaMb=200（两 return 分支内置默认）', () => {
    expect(getGlobalSettings().journalQuotaMb).toBe(200);
  });
  it('updateGlobalSettings 部分更新 + 往返保真（含小数——quota 测试经 1/1024 注入 1KB）', () => {
    updateGlobalSettings({ journalQuotaMb: 500 });
    expect(getGlobalSettings().journalQuotaMb).toBe(500);
    updateGlobalSettings({ journalQuotaMb: 0.5 });
    expect(getGlobalSettings().journalQuotaMb).toBe(0.5);
    updateGlobalSettings({ journalQuotaMb: 1 / 1024 });
    expect(getGlobalSettings().journalQuotaMb).toBe(1 / 1024);
    // 部分更新不殃及其他字段
    expect(getGlobalSettings().maxToolCalls).toBe(10);
  });
});
