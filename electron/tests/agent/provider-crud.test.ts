// provider CRUD 单测：用内存 keychain + 临时 DB，验证增删改查 + is_default 排他
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import {
  listProviders, createProvider, updateProvider, deleteProvider,
  setDefaultProvider, getProvider,
} from '../../src/main/agent/provider-crud';

const tmpRoot = path.join(os.tmpdir(), `ap-provider-test-${Date.now()}`);
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

describe('provider-crud', () => {
  it('createProvider 落库 + apiKey 入 keychain', async () => {
    runMigrations();
    const p = await createProvider({
      name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKey: 'sk-xxx', defaultModel: 'glm-5.2',
    });
    expect(p.name).toBe('GLM');
    expect(p.isDefault).toBe(false);
    // apiKey 入 keychain（key = provider.<id>.api_key）
    expect(memStore.get(`provider.${p.id}.api_key`)).toBe('sk-xxx');
    // 查询返回不含 apiKey
    expect(listProviders()).toHaveLength(1);
  });

  it('listProviders 不返回 apiKey', async () => {
    runMigrations();
    await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    const list = listProviders();
    expect(list[0]).not.toHaveProperty('apiKey');
  });

  it('setDefaultProvider 排他（仅一个 is_default=1）', async () => {
    runMigrations();
    const a = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k', isDefault: true });
    const b = await createProvider({ name: 'B', baseUrl: 'u', apiKey: 'k' });
    setDefaultProvider(b.id);
    expect(getProvider(a.id)?.isDefault).toBe(false);
    expect(getProvider(b.id)?.isDefault).toBe(true);
  });

  it('updateProvider 仅在 apiKey 非空时更新 keychain', async () => {
    runMigrations();
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'old' });
    await updateProvider({ id: p.id, name: 'A2' }); // 不传 apiKey
    expect(memStore.get(`provider.${p.id}.api_key`)).toBe('old');
    expect(getProvider(p.id)?.name).toBe('A2');
    await updateProvider({ id: p.id, apiKey: 'new' });
    expect(memStore.get(`provider.${p.id}.api_key`)).toBe('new');
  });

  it('deleteProvider 删 DB + 删 keychain', async () => {
    runMigrations();
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    await deleteProvider(p.id);
    expect(listProviders()).toHaveLength(0);
    expect(memStore.has(`provider.${p.id}.api_key`)).toBe(false);
  });

  it('createProvider name 唯一约束冲突抛错', async () => {
    runMigrations();
    await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    await expect(createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' })).rejects.toThrow();
  });
});
