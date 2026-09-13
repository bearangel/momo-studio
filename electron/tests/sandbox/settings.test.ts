// electron/tests/sandbox/settings.test.ts
//
// 沙箱设置读取测试（2026-09-13 修订 B：网络策略三态收敛双态 allow/deny）：
//   - testOverride 钩子优先于 DB；置 null 后回退 GlobalSettings
//   - kv 懒迁移：遗留值 'ask' → 重写为 'allow'；旧布尔键 true/false → 一律
//     'allow'（双态时代新默认即 allow，两分支同值收敛）；全缺省（全新库）→
//     'allow' 并写回新键；显式 'deny' 原样保留（不重写）
//   - 新键非法值（脏库）→ 回退新默认 'allow' 不抛错
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

/** 直写 global_settings 原始 JSON（构造三态时代遗留 'ask' 值用） */
function writeRawGlobal(patch: Record<string, unknown>): void {
  const base = readRawGlobal();
  getDb()
    .prepare(
      `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run('global_settings', JSON.stringify({ ...base, ...patch }));
}

describe('sandbox/settings（testOverride）', () => {
  it('testOverride 注入后优先生效（无需 DB 值，不触发迁移）', () => {
    __setSandboxSettingsForTest({ mode: 'permissive', networkPolicy: 'deny' });
    expect(getSandboxSettings()).toEqual({ mode: 'permissive', networkPolicy: 'deny' });
    expect(readRawGlobal().sandboxNetworkPolicy).toBeUndefined();
  });

  it('override 置 null 后走 DB，缺省 strict / allow（双态时代新默认）', () => {
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings()).toEqual({ mode: 'strict', networkPolicy: 'allow' });
  });
});

describe('sandbox/settings kv 懒迁移（修订 B：双态收敛）', () => {
  it('遗留新键值 ask（三态时代）→ 重写为 allow 且返回 allow', () => {
    writeRawGlobal({ sandboxNetworkPolicy: 'ask' });
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings().networkPolicy).toBe('allow');
    expect(readRawGlobal().sandboxNetworkPolicy).toBe('allow'); // 重写已落库
  });

  it('旧布尔键 sandboxNetwork=true → allow，且写回新键、旧键留存（回滚安全）', () => {
    updateGlobalSettings({ sandboxNetwork: true });
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings()).toEqual({ mode: 'strict', networkPolicy: 'allow' });
    const raw = readRawGlobal();
    expect(raw.sandboxNetworkPolicy).toBe('allow'); // 新键已写
    expect(raw.sandboxNetwork).toBe(true); // 旧键留存不删
  });

  it('旧布尔键 sandboxNetwork=false → 同样 allow（双态默认即 allow——布尔两值同向收敛）', () => {
    updateGlobalSettings({ sandboxNetwork: false });
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings().networkPolicy).toBe('allow');
    expect(readRawGlobal().sandboxNetworkPolicy).toBe('allow');
    expect(readRawGlobal().sandboxNetwork).toBe(false);
  });

  it('旧键缺省（从未写过设置）→ allow（迁移把 allow 写回新键，幂等无害）', () => {
    // 全新 DB：global_settings 无行 → crud 透传 undefined → 走迁移分支（缺省→allow）
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings().networkPolicy).toBe('allow');
    expect(readRawGlobal().sandboxNetworkPolicy).toBe('allow');
  });

  it('显式 deny → 原样保留（不重写；拒绝是双态合法值）', () => {
    updateGlobalSettings({ sandboxNetworkPolicy: 'deny' });
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings().networkPolicy).toBe('deny');
    // 读取不触发任何写（deny 直接命中快路径）
    expect(readRawGlobal().sandboxNetworkPolicy).toBe('deny');
  });

  it('显式 allow → 原样命中（不进迁移分支）', () => {
    writeRawGlobal({ sandboxNetworkPolicy: 'allow' });
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings().networkPolicy).toBe('allow');
  });

  it('新键非法值（脏库）→ 回退 allow 不抛错', () => {
    writeRawGlobal({ sandboxNetworkPolicy: 'yolo' });
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings().networkPolicy).toBe('allow');
  });

  it('设置面板写入路径：updateGlobal({ sandboxNetworkPolicy }) 后读回生效（双态全值）', () => {
    for (const p of ['deny', 'allow'] as const) {
      updateGlobalSettings({ sandboxNetworkPolicy: p });
      expect(getSandboxSettings().networkPolicy).toBe(p);
    }
  });
});

describe('sandbox/settings 既有行为保持（v2.4 基线）', () => {
  it('DB 里非法 mode 收敛为 strict（sandboxMode 只认 permissive）', () => {
    writeRawGlobal({ sandboxMode: 'yolo' });
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings().mode).toBe('strict');
  });

  it('DB 写入的 permissive 真实读出（锁 DB 通路非硬编码）', () => {
    updateGlobalSettings({ sandboxMode: 'permissive' });
    __setSandboxSettingsForTest(null);
    expect(getSandboxSettings().mode).toBe('permissive');
  });
});
