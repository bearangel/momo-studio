// provider_models CRUD + provider platform 读写测试：
// 验证 platform 列读写往返（含 CHECK 约束在 DB 层生效）与
// provider_models 的 upsert 幂等 / 启用切换 / 移除 / 级联删除。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import {
  createProvider, getProvider, updateProvider, deleteProvider,
  listProviderModels, upsertProviderModel, setProviderModelEnabled,
  removeProviderModel, setProviderModelWindow,
} from '../../src/main/agent/provider-crud';

const tmpRoot = path.join(os.tmpdir(), `ap-provider-models-${Date.now()}`);
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

describe('provider platform', () => {
  it('createProvider 不传 platform → 默认 openai', async () => {
    const p = await createProvider({ name: 'GLM', baseUrl: 'u', apiKey: 'k' });
    expect(p.platform).toBe('openai');
    expect(getProvider(p.id)?.platform).toBe('openai');
  });

  it('createProvider platform=anthropic 读写往返', async () => {
    const p = await createProvider({
      name: 'Claude', baseUrl: 'https://api.anthropic.com', apiKey: 'k', platform: 'anthropic',
    });
    expect(p.platform).toBe('anthropic');
    expect(getProvider(p.id)?.platform).toBe('anthropic');
  });

  it('updateProvider 修改 platform', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    const updated = await updateProvider({ id: p.id, platform: 'anthropic' });
    expect(updated.platform).toBe('anthropic');
    expect(getProvider(p.id)?.platform).toBe('anthropic');
  });

  it('DB 层 CHECK 约束拒绝非法 platform（直接 INSERT 抛错）', () => {
    expect(() => {
      getDb()
        .prepare(
          "INSERT INTO model_providers (id, name, base_url, api_key_ref, platform) VALUES (?, ?, ?, ?, ?)",
        )
        .run('raw-1', 'Raw', 'u', 'r', 'azure');
    }).toThrow();
  });
});

describe('provider_models CRUD', () => {
  it('upsertProviderModel 插入 + listProviderModels 返回（默认 enabled=true）', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    upsertProviderModel(p.id, 'glm-5.2');
    upsertProviderModel(p.id, 'glm-5.3');
    const models = listProviderModels(p.id);
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ providerId: p.id, modelId: 'glm-5.2', enabled: true });
    expect(typeof models[0].addedAt).toBe('number');
  });

  it('upsertProviderModel 幂等（重复调用不报错不重复）', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    upsertProviderModel(p.id, 'm1');
    upsertProviderModel(p.id, 'm1');
    expect(listProviderModels(p.id)).toHaveLength(1);
  });

  it('upsertProviderModel 幂等不覆盖已切换的 enabled（INSERT OR IGNORE 语义）', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    upsertProviderModel(p.id, 'm1');
    setProviderModelEnabled(p.id, 'm1', false);
    upsertProviderModel(p.id, 'm1');
    const m = listProviderModels(p.id).find((x) => x.modelId === 'm1');
    expect(m?.enabled).toBe(false);
  });

  it('upsertProviderModel 可指定初始 enabled=false', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    upsertProviderModel(p.id, 'm1', false);
    const m = listProviderModels(p.id).find((x) => x.modelId === 'm1');
    expect(m?.enabled).toBe(false);
  });

  it('setProviderModelEnabled 切换启用状态', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    upsertProviderModel(p.id, 'm1');
    setProviderModelEnabled(p.id, 'm1', false);
    expect(listProviderModels(p.id)[0].enabled).toBe(false);
    setProviderModelEnabled(p.id, 'm1', true);
    expect(listProviderModels(p.id)[0].enabled).toBe(true);
  });

  it('removeProviderModel 删除指定模型行', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    upsertProviderModel(p.id, 'm1');
    upsertProviderModel(p.id, 'm2');
    removeProviderModel(p.id, 'm1');
    const models = listProviderModels(p.id);
    expect(models).toHaveLength(1);
    expect(models[0].modelId).toBe('m2');
  });

  it('listProviderModels 按 provider 隔离 + 未知 provider 返回空数组', async () => {
    const a = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    const b = await createProvider({ name: 'B', baseUrl: 'u', apiKey: 'k' });
    upsertProviderModel(a.id, 'shared-model');
    expect(listProviderModels(a.id)).toHaveLength(1);
    expect(listProviderModels(b.id)).toHaveLength(0);
    expect(listProviderModels('ghost')).toEqual([]);
  });

  it('deleteProvider 级联删除其模型列表（ON DELETE CASCADE）', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    upsertProviderModel(p.id, 'm1');
    upsertProviderModel(p.id, 'm2');
    await deleteProvider(p.id);
    expect(listProviderModels(p.id)).toEqual([]);
  });

  it('upsertProviderModel 对不存在的 provider 抛 FOREIGN KEY 约束错误（IPC 层面即 addModel 报错）', () => {
    // provider:addModel 直接透传 upsertProviderModel——ghost provider 时
    // SqliteError: FOREIGN KEY constraint failed 会作为 IPC error 传给 renderer
    expect(() => upsertProviderModel('ghost-provider', 'm1')).toThrow(/FOREIGN KEY/);
  });
});

describe('provider_models.context_window（压缩重构 Task 1，migration v30）', () => {
  it('新插入行缺省 contextWindow=null（未知，走内置目录）', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    upsertProviderModel(p.id, 'm1');
    expect(listProviderModels(p.id)[0].contextWindow).toBeNull();
  });

  it('setProviderModelWindow 写入后 listProviderModels 读回', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    upsertProviderModel(p.id, 'm1');
    setProviderModelWindow(p.id, 'm1', 131072);
    expect(listProviderModels(p.id)[0].contextWindow).toBe(131072);
  });

  it('setProviderModelWindow(null) 清除覆盖（回退内置目录）', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    upsertProviderModel(p.id, 'm1');
    setProviderModelWindow(p.id, 'm1', 131072);
    setProviderModelWindow(p.id, 'm1', null);
    expect(listProviderModels(p.id)[0].contextWindow).toBeNull();
  });

  it('非法值（0 / 负数 / 非整数）在写通道源头被拒', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    upsertProviderModel(p.id, 'm1');
    expect(() => setProviderModelWindow(p.id, 'm1', 0)).toThrow();
    expect(() => setProviderModelWindow(p.id, 'm1', -100)).toThrow();
    expect(() => setProviderModelWindow(p.id, 'm1', 1.5)).toThrow();
    // 拒绝后原值不被污染
    expect(listProviderModels(p.id)[0].contextWindow).toBeNull();
  });

  it('不存在的模型行：no-op 不炸（与 setProviderModelEnabled 行为一致）', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    expect(() => setProviderModelWindow(p.id, 'ghost-model', 1000)).not.toThrow();
  });
});
