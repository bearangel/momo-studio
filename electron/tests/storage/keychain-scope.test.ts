// electron/tests/storage/keychain-scope.test.ts
//
// M3.0 T5 门面服务名作用域（D2 用例迁移 + 门面分域新契约）：
//   - 默认 profile → 服务名 'Momo Studio' 完全不变（既有凭证零变化）
//   - 两个隔离目录 → 两个不同分域服务名，写入互不可见（串味回归锁）
//   - provider / agent / plugin 三族代表键写入均走分域服务名（门面单一咽喉）
//   - D2 等价：隔离目录下 hub deviceToken 落在分域服务名的**裸**账户键
//
// 测试经 keytar 形状后端注入（setKeytarBackendForTest）走**真实生产门面实现**
// （__resetKeychainImplForTest）——fake 收到的 service 参数即作用域后的服务名；
// 全仓既有 40+ 文件的 setKeychainImpl 注入惯例不受影响（KeychainImpl 形状未动）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setSecret,
  getSecret,
  deleteSecret,
  keychainServiceName,
  wireKeychainScope,
  setKeytarBackendForTest,
  __resetKeychainImplForTest,
  __resetKeychainScopeForTest,
  type KeytarLike,
} from '../../src/main/storage/keychain';
import { setDeviceToken, getDeviceToken } from '../../src/main/hub/creds';
import { deriveProfileScopeSuffix } from '../../src/main/util/profile-scope';

/** fake native keytar：按 service + account 双键记账（keytar 命名空间语义） */
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
}

// 默认 userData 全路径形态（<appData>/<app.name>）——与生产接线第二参同构
const DEFAULT_UD = '/Users/tom/Library/Application Support/Momo Studio';
const DIR_A = '/tmp/qa-run-A/profile';
const DIR_B = '/tmp/qa-run-B/profile';

let fake: FakeKeytar;

beforeEach(() => {
  fake = new FakeKeytar();
  __resetKeychainImplForTest();
  setKeytarBackendForTest(fake);
  __resetKeychainScopeForTest();
});

afterEach(() => {
  __resetKeychainScopeForTest();
  setKeytarBackendForTest(null);
  __resetKeychainImplForTest();
});

describe('T5 门面作用域双态', () => {
  it('默认 profile（未接线 / 默认路径接线）→ 裸服务名 Momo Studio（既有凭证零变化）', async () => {
    await setSecret('provider.anthropic.api_key', 'sk-default');
    expect(keychainServiceName()).toBe('Momo Studio');
    expect(fake.store.get('Momo Studio\u0000provider.anthropic.api_key')).toBe('sk-default');

    // 显式按默认路径接线 → 同一裸服务名（与未接线形态等价）
    wireKeychainScope(DEFAULT_UD, DEFAULT_UD);
    expect(keychainServiceName()).toBe('Momo Studio');
    expect(await getSecret('provider.anthropic.api_key')).toBe('sk-default');
  });

  it('两个不同隔离目录 → 两个不同分域服务名、互不可见（串味回归锁——M1 验收 D5 根因）', async () => {
    wireKeychainScope(DIR_A, DEFAULT_UD);
    const svcA = keychainServiceName();
    await setSecret('provider.anthropic.api_key', 'tok-A');

    wireKeychainScope(DIR_B, DEFAULT_UD);
    const svcB = keychainServiceName();
    expect(svcA).toMatch(/^Momo Studio-[0-9a-f]{8}$/);
    expect(svcB).toMatch(/^Momo Studio-[0-9a-f]{8}$/);
    expect(svcA).not.toBe(svcB);

    // B 实例读不到 A 写入的凭证；A 的键在 A 的服务名下原样在场
    expect(await getSecret('provider.anthropic.api_key')).toBeNull();
    expect(fake.store.get(`${svcA}\u0000provider.anthropic.api_key`)).toBe('tok-A');

    // B 实例写入同键不覆盖 A（keytar 命名空间 = service + account 分域）
    await setSecret('provider.anthropic.api_key', 'tok-B');
    expect(fake.store.get(`${svcA}\u0000provider.anthropic.api_key`)).toBe('tok-A');
    expect(fake.store.get(`${svcB}\u0000provider.anthropic.api_key`)).toBe('tok-B');

    // 清理只清自身分域
    await deleteSecret('provider.anthropic.api_key');
    expect(fake.store.has(`${svcB}\u0000provider.anthropic.api_key`)).toBe(false);
    expect(fake.store.get(`${svcA}\u0000provider.anthropic.api_key`)).toBe('tok-A');
  });

  it('服务名派生与 deriveProfileScopeSuffix 单源一致（门面不另算 hash）', () => {
    wireKeychainScope(DIR_A, DEFAULT_UD);
    const suffix = deriveProfileScopeSuffix(DIR_A, DEFAULT_UD);
    expect(keychainServiceName()).toBe(`Momo Studio-${suffix}`);
  });
});

describe('T5 五族账户键写入走分域服务名（门面单一咽喉）', () => {
  it.each([
    ['provider.<id>.api_key', 'provider.anthropic.api_key'],
    ['agent.<instanceId>.api_key_override', 'agent.inst-42.api_key_override'],
    ['plugin.<pluginId>.config.<key>', 'plugin.codegraph.config.apiToken'],
    ['agent.<instanceId>.llm_api_key（legacy）', 'agent.inst-42.llm_api_key'],
  ])('%s → 分域服务名', async (_label, key) => {
    wireKeychainScope(DIR_A, DEFAULT_UD);
    const svc = keychainServiceName();
    await setSecret(key, 'val');
    // 写在分域服务名下；默认服务名下不得出现该键（防串味）
    expect(fake.store.get(`${svc}\u0000${key}`)).toBe('val');
    expect(fake.store.get(`Momo Studio\u0000${key}`)).toBeUndefined();
  });
});

describe('T5 D2 用例迁移：隔离目录下 hub token 落在分域服务名的裸账户键', () => {
  it('隔离实例 setDeviceToken → 分域服务名 + 裸 hub.deviceToken 键（账户键不再随实例漂移）', async () => {
    wireKeychainScope(DIR_A, DEFAULT_UD);
    const svc = keychainServiceName();
    await setDeviceToken('tok-A');
    expect(fake.store.get(`${svc}\u0000hub.deviceToken`)).toBe('tok-A');
    // D2 旧形态键（默认服务名下的 hub.deviceToken.<suffix>）不存在——迁移裁定：
    // 隔离实例升级后读不到旧键，按新身份重新 enroll（creds.ts 文件头裁决）
    expect(
      fake.store.get(`Momo Studio\u0000hub.deviceToken.${deriveProfileScopeSuffix(DIR_A, DEFAULT_UD)}`),
    ).toBeUndefined();
    expect(await getDeviceToken()).toBe('tok-A');
  });

  it('默认实例 deviceToken → 裸服务名 + 裸键（既有凭证直接沿用，零变化）', async () => {
    wireKeychainScope(DEFAULT_UD, DEFAULT_UD);
    await setDeviceToken('tok-default');
    expect(fake.store.get('Momo Studio\u0000hub.deviceToken')).toBe('tok-default');
    expect(await getDeviceToken()).toBe('tok-default');
  });
});
