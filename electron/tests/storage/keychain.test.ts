// electron/tests/storage/keychain.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setSecret,
  getSecret,
  deleteSecret,
  setKeychainImpl,
} from '../../src/main/storage/keychain';

class MockKeychain {
  store = new Map<string, string>();
  async setSecret(key: string, value: string) {
    this.store.set(key, value);
  }
  async getSecret(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async deleteSecret(key: string): Promise<void> {
    this.store.delete(key);
  }
}

describe('keychain', () => {
  beforeEach(() => {
    setKeychainImpl(new MockKeychain());
  });

  it('setSecret and getSecret round-trip', async () => {
    await setSecret('foo', 'bar');
    expect(await getSecret('foo')).toBe('bar');
  });

  it('getSecret returns null for missing key', async () => {
    expect(await getSecret('missing')).toBeNull();
  });

  it('deleteSecret removes key', async () => {
    await setSecret('foo', 'bar');
    await deleteSecret('foo');
    expect(await getSecret('foo')).toBeNull();
  });
});
