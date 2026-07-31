// provider-crud 边界 + migration v10 幂等测试：补齐 provider-crud.test.ts 未覆盖的路径。
// 用内存 keychain + 临时真实 DB，遵循 provider-crud.test.ts 的既有模式。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import {
  getProvider, createProvider, updateProvider, deleteProvider, listProviders,
} from '../../src/main/agent/provider-crud';

const tmpRoot = path.join(os.tmpdir(), `ap-provider-edges-${Date.now()}`);
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
  runMigrations();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

describe('provider-crud 边界', () => {
  it('getProvider 未知 id 返回 null', () => {
    expect(getProvider('does-not-exist')).toBeNull();
  });

  it('updateProvider 不存在的 id 抛错（携带 id）', async () => {
    await expect(updateProvider({ id: 'ghost', name: 'X' })).rejects.toThrow(/供应商不存在/);
  });

  it('deleteProvider 不存在的 id 不抛错（DELETE 0 行 + keychain 删缺失 key 均安全）', async () => {
    await expect(deleteProvider('ghost')).resolves.toBeUndefined();
  });

  it('createProvider isDefault:true → 立即成为唯一默认', async () => {
    await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k', isDefault: true });
    const b = await createProvider({ name: 'B', baseUrl: 'u', apiKey: 'k', isDefault: true });
    // B 也置默认后，A 应被自动取消
    const list = listProviders();
    const defaults = list.filter((p) => p.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(b.id);
  });

  it('updateProvider isDefault:true 排他取消其它默认', async () => {
    const a = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k', isDefault: true });
    const b = await createProvider({ name: 'B', baseUrl: 'u', apiKey: 'k' });
    await updateProvider({ id: b.id, isDefault: true });
    expect(getProvider(a.id)?.isDefault).toBe(false);
    expect(getProvider(b.id)?.isDefault).toBe(true);
  });

  it('updateProvider defaultModel 传 null 显式清空（区别于"不传"保留）', async () => {
    const p = await createProvider({
      name: 'A', baseUrl: 'u', apiKey: 'k', defaultModel: 'glm-5.2',
    });
    expect(getProvider(p.id)?.defaultModel).toBe('glm-5.2');
    await updateProvider({ id: p.id, defaultModel: null });
    expect(getProvider(p.id)?.defaultModel).toBeNull();
  });

  it('apiKey 只入 keychain，DB 行的 api_key_ref 是引用 key 而非明文', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'secret-val' });
    const row = getDb()
      .prepare('SELECT api_key_ref FROM model_providers WHERE id = ?')
      .get(p.id) as { api_key_ref: string };
    expect(row.api_key_ref).toBe(`provider.${p.id}.api_key`);
    // 明文绝不出现在 DB
    expect(JSON.stringify(row)).not.toContain('secret-val');
  });
});

describe('migration v10 幂等与约束', () => {
  it('重复 runMigrations 不丢数据（CREATE TABLE IF NOT EXISTS 幂等）', async () => {
    const p = await createProvider({ name: 'Keep', baseUrl: 'u', apiKey: 'k' });
    runMigrations(); // 二次执行：已 applied 的 migration 被跳过
    expect(listProviders()).toHaveLength(1);
    expect(listProviders()[0].id).toBe(p.id);
  });

  it('model_providers.name 唯一约束在 DB 层生效（直接 INSERT 冲突）', () => {
    expect(() => {
      getDb()
        .prepare('INSERT INTO model_providers (id, name, base_url, api_key_ref) VALUES (?, ?, ?, ?)')
        .run('id-1', 'Dup', 'u', 'ref-1');
      getDb()
        .prepare('INSERT INTO model_providers (id, name, base_url, api_key_ref) VALUES (?, ?, ?, ?)')
        .run('id-2', 'Dup', 'u', 'ref-2');
    }).toThrow();
  });
});
