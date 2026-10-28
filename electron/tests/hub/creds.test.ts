// hub device token 凭证：keychain 通道读写清（经 keychain.ts 既有注入钩子——不新增注入机制）。
// M3.0 T5：实例隔离已上收到 keychain 门面服务名（wireKeychainScope）——本模块
// 回归裸 'hub.deviceToken' 账户键；作用域派生用例迁 tests/util/profile-scope.test.ts，
// 分域/互不可见用例迁 tests/storage/keychain-scope.test.ts。
import { describe, expect, it } from 'vitest';
import {
  clearDeviceToken,
  getDeviceToken,
  setDeviceToken,
} from '../../src/main/hub/creds';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';

class FakeKeychain implements KeychainImpl {
  store = new Map<string, string>();
  async setSecret(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async getSecret(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async deleteSecret(key: string): Promise<void> { this.store.delete(key); }
}

describe('hub creds', () => {
  it('set → get → clear 走 keychain 同一裸 key（hub.deviceToken，键名不随实例漂移）', async () => {
    const fake = new FakeKeychain();
    setKeychainImpl(fake);
    await setDeviceToken('dt-1');
    expect(await getDeviceToken()).toBe('dt-1');
    // T5 后键恒为裸形态——不存在 hub.deviceToken.<suffix> 账户键行径
    expect([...fake.store.keys()]).toEqual(['hub.deviceToken']);
    await clearDeviceToken();
    expect(await getDeviceToken()).toBeNull();
  });

  it('无凭证 → null（隔离实例升级后旧键不可见 → 按 D2 裁决重新 enroll）', async () => {
    setKeychainImpl(new FakeKeychain());
    expect(await getDeviceToken()).toBeNull();
  });
});
