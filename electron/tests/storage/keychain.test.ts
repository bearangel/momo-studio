// electron/tests/storage/keychain.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setSecret,
  getSecret,
  deleteSecret,
  setKeychainImpl,
  setKeytarBackendForTest,
  __resetKeychainImplForTest,
  findSecretKeysByPrefix,
  type KeytarLike,
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

describe('findSecretKeysByPrefix（插件自管 secrets 卸载级联依赖）', () => {
  /** fake native keytar：按 service + account 双键记账（与 keychain-scope.test.ts 同存储惯例） */
  class FakeKeytar implements KeytarLike {
    store = new Map<string, string>();
    private k(service: string, account: string): string {
      return `${service}\u0000${account}`;
    }
    async setPassword(service: string, account: string, password: string): Promise<void> {
      this.store.set(this.k(service, account), password);
    }
    async getPassword(service: string, account: string): Promise<string | null> {
      return this.store.get(this.k(service, account)) ?? null;
    }
    async deletePassword(service: string, account: string): Promise<boolean> {
      return this.store.delete(this.k(service, account));
    }
    async findCredentials(service: string): Promise<Array<{ account: string; password: string }>> {
      return [...this.store.entries()]
        .filter(([key]) => key.startsWith(`${service}\u0000`))
        .map(([key, password]) => ({ account: key.slice(service.length + 1), password }));
    }
  }

  beforeEach(() => {
    __resetKeychainImplForTest();
    setKeytarBackendForTest(new FakeKeytar());
  });

  afterEach(() => {
    setKeytarBackendForTest(null);
    __resetKeychainImplForTest();
  });

  it('findSecretKeysByPrefix 按服务名前缀枚举账号键（插件自管 secrets 清理依赖）', async () => {
    await setSecret('plugin/email/secret/account:acc1', 'x');
    await setSecret('plugin/email/secret/account:acc2', 'y');
    await setSecret('plugin/other/secret/k', 'z');
    const keys = await findSecretKeysByPrefix('plugin/email/secret/');
    expect([...keys].sort()).toEqual([
      'plugin/email/secret/account:acc1',
      'plugin/email/secret/account:acc2',
    ]);
    expect(await findSecretKeysByPrefix('plugin/none/secret/')).toEqual([]);
  });
});
