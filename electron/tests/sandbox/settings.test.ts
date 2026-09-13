// electron/tests/sandbox/settings.test.ts
//
// 沙箱设置读取测试（v2.4.x 网络三态迁移，spec 2026-09-13 §4）：
//   - testOverride 钩子优先于 DB；置 null 后回退 GlobalSettings
//   - kv 懒迁移三分支：旧键 sandboxNetwork true→allow / false→ask / 缺省→ask，
//     迁移后写新键 sandboxNetworkPolicy、旧键留存（回滚安全）
//   - 新键存在时直接生效（不迁移）；非法新键值回退 ask
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

/** 直读 kv_store 里 global_settings 的原始 JSON（迁移写回断言用） */
function readRawGlobal(): Record<string, unknown> {
  const row = getDb().prepare('SELECT value FROM kv_store WHERE key = ?').get('global_settings') as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as Record<string, unknown>) : {};
}

describe('sandbox/settings（testOverride）', () => {
  it('testOverride 注入后优先生效（无需 DB 值，不触发迁移）', () => {
    __setSandboxSettingsForTest({ mode: 'permissive', networkPolicy: 'allow' });
    expect(getSandboxSettings()).toEqual({ mode: 'permissive', networkPolicy: 'allow' });
    expect(readRawGlobal().sandboxNetworkPolicy).toBeUndefined();
  });

  it('override 置 null 后走 DB，缺省 strict / ask（v2.4.x 起缺省从 false 改为 ask）', () => {
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings()).toEqual({ mode: 'strict', networkPolicy: 'ask' });
  });
});

describe('sandbox/settings kv 懒迁移三分支（spec §4）', () => {
  it('旧键 sandboxNetwork=true → allow，且写回新键、旧键留存（回滚安全）', () => {
    updateGlobalSettings({ sandboxNetwork: true });
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings()).toEqual({ mode: 'strict', networkPolicy: 'allow' });
    const raw = readRawGlobal();
    expect(raw.sandboxNetworkPolicy).toBe('allow'); // 新键已写
    expect(raw.sandboxNetwork).toBe(true); // 旧键留存不删
  });

  it('旧键 sandboxNetwork=false → ask（明确关过的用户回到询问而非继续全断）', () => {
    updateGlobalSettings({ sandboxNetwork: false });
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings().networkPolicy).toBe('ask');
    expect(readRawGlobal().sandboxNetworkPolicy).toBe('ask');
    expect(readRawGlobal().sandboxNetwork).toBe(false);
  });

  it('旧键缺省（从未写过设置）→ ask（迁移把 ask 写回新键，幂等无害）', () => {
    // 全新 DB：global_settings 无行 → crud 透传 undefined → 走迁移分支（false/缺省→ask）
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings().networkPolicy).toBe('ask');
    expect(readRawGlobal().sandboxNetworkPolicy).toBe('ask');
  });

  it('新键已存在 → 直接生效不迁移（旧键被忽略）', () => {
    updateGlobalSettings({ sandboxNetwork: true, sandboxNetworkPolicy: 'deny' });
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings().networkPolicy).toBe('deny');
  });

  it('新键非法值（脏库）→ 回退 ask 不抛错', () => {
    getDb()
      .prepare(
        `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run('global_settings', JSON.stringify({ sandboxNetworkPolicy: 'yolo' }));
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings().networkPolicy).toBe('ask');
  });

  it('设置面板写入路径：updateGlobal({ sandboxNetworkPolicy }) 后读回生效（三态全值）', () => {
    for (const p of ['deny', 'ask', 'allow'] as const) {
      updateGlobalSettings({ sandboxNetworkPolicy: p });
      expect(getSandboxSettings().networkPolicy).toBe(p);
    }
  });
});

describe('sandbox/settings 既有行为保持（v2.4 基线）', () => {
  it('DB 里非法 mode 收敛为 strict（sandboxMode 只认 permissive）', () => {
    getDb()
      .prepare(
        `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run('global_settings', JSON.stringify({ sandboxMode: 'yolo' }));
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings().mode).toBe('strict');
  });

  it('DB 写入的 permissive 真实读出（锁 DB 通路非硬编码）', () => {
    updateGlobalSettings({ sandboxMode: 'permissive' });
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings().mode).toBe('permissive');
  });
});
