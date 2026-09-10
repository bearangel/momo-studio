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
