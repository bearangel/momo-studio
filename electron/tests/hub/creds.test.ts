// hub device token 凭证：keychain 通道读写清（经 keychain.ts 既有注入钩子——不新增注入机制）。
// D2（M2 Task 1）：实例作用域键——同机多实例（隔离 userData 目录）共享 OS keychain
// 串味（A 实例读到 B 的 token，节点身份错乱，M1 验收 D5 根因）→ token 键加由
// userData 目录名稳定派生的作用域后缀；默认单实例后缀为空 = 裸键（向后兼容）。
// 简化裁定：不做跨键迁移——非默认实例视为新身份重新 enroll（一次性验收/开发场景）。
import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  clearDeviceToken,
  deriveDeviceTokenScopeSuffix,
  getDeviceToken,
  setDeviceToken,
  setDeviceTokenScopeResolver,
  __resetDeviceTokenScopeForTest,
} from '../../src/main/hub/creds';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { logger } from '../../src/main/logger';

class FakeKeychain implements KeychainImpl {
  store = new Map<string, string>();
  async setSecret(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async getSecret(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async deleteSecret(key: string): Promise<void> { this.store.delete(key); }
}

afterEach(() => {
  __resetDeviceTokenScopeForTest();
});

describe('hub creds', () => {
  it('set → get → clear 走 keychain 同一 key（hub.deviceToken）', async () => {
    const fake = new FakeKeychain();
    setKeychainImpl(fake);
    await setDeviceToken('dt-1');
    expect(await getDeviceToken()).toBe('dt-1');
    expect([...fake.store.keys()]).toEqual(['hub.deviceToken']);
    await clearDeviceToken();
    expect(await getDeviceToken()).toBeNull();
  });
});

describe('deriveDeviceTokenScopeSuffix（作用域派生纯函数，D2）', () => {
  it('默认目录 basename → 空后缀（单实例常态，裸键向后兼容）', () => {
    expect(deriveDeviceTokenScopeSuffix('/tmp/appData/Momo Studio', 'Momo Studio')).toBe('');
  });

  it('隔离目录 basename → sha256 前 8 位 hex（同目录稳定可复现）', () => {
    const a = deriveDeviceTokenScopeSuffix('/tmp/qa/momo-qa-profile-A', 'Momo Studio');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(deriveDeviceTokenScopeSuffix('/tmp/qa/momo-qa-profile-A', 'Momo Studio')).toBe(a);
  });

  it('不同隔离目录 → 不同后缀（双实例键不撞）', () => {
    const a = deriveDeviceTokenScopeSuffix('/tmp/qa/profile-A', 'Momo Studio');
    const b = deriveDeviceTokenScopeSuffix('/tmp/qa/profile-B', 'Momo Studio');
    expect(a).not.toBe(b);
  });
});

describe('D2 双实例作用域键隔离（mock keychain 键集合）', () => {
  it('两 scope 各自读写不相扰：三键并存、清理只清自己 scope、裸键不被触碰', async () => {
    const fake = new FakeKeychain();
    setKeychainImpl(fake);
    // 默认实例既有凭证（裸键）——隔离实例的一切读写都不得影响它
    await fake.setSecret('hub.deviceToken', 'tok-default');

    setDeviceTokenScopeResolver(() => 'aaaaaaaa');
    await setDeviceToken('tok-A');
    setDeviceTokenScopeResolver(() => 'bbbbbbbb');
    await setDeviceToken('tok-B');

    setDeviceTokenScopeResolver(() => 'aaaaaaaa');
    expect(await getDeviceToken()).toBe('tok-A');
    setDeviceTokenScopeResolver(() => 'bbbbbbbb');
    expect(await getDeviceToken()).toBe('tok-B');

    // 键集合：三个键互不覆盖（OS keychain 同 service 下并存）
    expect(fake.store.get('hub.deviceToken')).toBe('tok-default');
    expect(fake.store.get('hub.deviceToken.aaaaaaaa')).toBe('tok-A');
    expect(fake.store.get('hub.deviceToken.bbbbbbbb')).toBe('tok-B');

    // 清理只清自身 scope
    setDeviceTokenScopeResolver(() => 'aaaaaaaa');
    await clearDeviceToken();
    expect(fake.store.has('hub.deviceToken.aaaaaaaa')).toBe(false);
    expect(fake.store.get('hub.deviceToken.bbbbbbbb')).toBe('tok-B');
    expect(fake.store.get('hub.deviceToken')).toBe('tok-default');
  });

  it('作用域实例读不到他 scope 写入的 token（串味回归锁——M1 验收 D5 根因）', async () => {
    const fake = new FakeKeychain();
    setKeychainImpl(fake);
    setDeviceTokenScopeResolver(() => 'aaaaaaaa');
    await setDeviceToken('tok-A');

    setDeviceTokenScopeResolver(() => 'bbbbbbbb');
    expect(await getDeviceToken()).toBeNull();
  });

  it('非默认 scope 旧裸键存在 → 不迁移：返回 null + warn 引导重新接入（仅告警一次）', async () => {
    const fake = new FakeKeychain();
    setKeychainImpl(fake);
    await fake.setSecret('hub.deviceToken', 'tok-default');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      setDeviceTokenScopeResolver(() => 'cccccccc');
      // 绝不吞默认实例凭证当自己的用
      expect(await getDeviceToken()).toBeNull();
      expect(fake.store.get('hub.deviceToken')).toBe('tok-default');

      const warns = () => warnSpy.mock.calls.filter((c) => String(c[0]).includes('hub'));
      expect(warns()).toHaveLength(1);
      await getDeviceToken();
      expect(warns()).toHaveLength(1); // warn-once：不随每次取 token 刷屏
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('默认实例（后缀空）沿用裸键——既有凭证直接可读（向后兼容）', async () => {
    const fake = new FakeKeychain();
    setKeychainImpl(fake);
    await fake.setSecret('hub.deviceToken', 'tok-default');
    // resolver 缺省 = 空后缀（未接线的测试/旧路径同形态）
    expect(await getDeviceToken()).toBe('tok-default');
  });
});
