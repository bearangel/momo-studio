// hub device token 凭证：keychain 通道读写清（经 keychain.ts 既有注入钩子——不新增注入机制）。
import { describe, expect, it } from 'vitest';
import { clearDeviceToken, getDeviceToken, setDeviceToken } from '../../src/main/hub/creds';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';

class FakeKeychain implements KeychainImpl {
  store = new Map<string, string>();
  async setSecret(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async getSecret(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async deleteSecret(key: string): Promise<void> { this.store.delete(key); }
}

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
