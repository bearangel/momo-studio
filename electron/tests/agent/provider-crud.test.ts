// provider CRUD 单测：用内存 keychain + 临时 DB，验证增删改查 + is_default 排他
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import {
  listProviders, createProvider, updateProvider, deleteProvider,
  setDefaultProvider, getProvider, markProviderVerified,
  listProviderModels, upsertProviderModel,
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

  it('验收补修（2026-11-02）：createProvider 携带 defaultModel → provider_models 落行（自定义供应商不再空列表）', async () => {
    runMigrations();
    const p = await createProvider({
      name: '自定义网关', baseUrl: 'https://gw.example.com/v1', apiKey: 'k',
      defaultModel: 'my-model-x',
    });
    const models = listProviderModels(p.id);
    expect(models.map((m) => m.modelId)).toEqual(['my-model-x']);
    expect(models[0]!.enabled).toBe(true);
    expect(getProvider(p.id)!.defaultModel).toBe('my-model-x');
  });

  it('验收补修：createProvider 未携带 defaultModel → 不凭空造模型行（既有语义保持）', async () => {
    runMigrations();
    const p = await createProvider({ name: '裸建', baseUrl: 'u', apiKey: 'k' });
    expect(listProviderModels(p.id)).toEqual([]);
    expect(getProvider(p.id)!.defaultModel).toBeNull();
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

// 走查 2026-10-12 修复配套：D3 删除阻断 / D7 验证时刻 / D12 preset 序。
describe('provider-crud 走查修复（D3/D7/D12）', () => {
  function insertAgentDef(id: string, name: string, providerId: string): void {
    getDb().prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
          default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', ?, 'm', 1)`,
    ).run(id, name, id, providerId);
  }

  it('D3：供应商被 agent 定义引用时删除被阻断并列出引用方', async () => {
    runMigrations();
    const p = await createProvider({ name: 'GLM', baseUrl: 'u', apiKey: 'k' });
    insertAgentDef('def-1', 'Momo', p.id);
    insertAgentDef('def-2', 'Smith', p.id);
    await expect(deleteProvider(p.id)).rejects.toThrow(/Momo、Smith/);
    // 引用清空后删除放行（DB + keychain 均清）
    getDb().prepare('DELETE FROM agent_definitions WHERE model_provider_id = ?').run(p.id);
    await deleteProvider(p.id);
    expect(listProviders()).toHaveLength(0);
    expect(memStore.has(`provider.${p.id}.api_key`)).toBe(false);
  });

  it('D7：createProvider 默认未验证；verifiedAtCreation 记录时刻；markProviderVerified 回写', async () => {
    runMigrations();
    const a = await createProvider({ name: 'A', baseUrl: 'u', apiKey: 'k' });
    expect(a.lastVerifiedAt).toBeNull();
    const b = await createProvider({ name: 'B', baseUrl: 'u', apiKey: 'k', verifiedAtCreation: true });
    expect(b.lastVerifiedAt).toBeTruthy();
    expect(new Date(b.lastVerifiedAt!).getTime()).toBeGreaterThan(0);
    markProviderVerified(a.id);
    expect(getProvider(a.id)?.lastVerifiedAt).toBeTruthy();
  });

  it('D12：preset 供应商模型按预设数组序返回（同毫秒种子不再落字母序），自添模型排后', async () => {
    runMigrations();
    const p = await createProvider({ name: 'Z', baseUrl: 'u', apiKey: 'k', presetKey: 'zhipu' });
    const ids = listProviderModels(p.id).map((m) => m.modelId);
    // zhipu 预设序：5.3 系在前、4.x 在后、4.6v 视觉线收尾
    expect(ids[0]).toBe('glm-5.3');
    expect(ids.indexOf('glm-5.2')).toBeLessThan(ids.indexOf('glm-4.7'));
    expect(ids.indexOf('glm-4.6')).toBeLessThan(ids.indexOf('glm-4.5'));
    expect(ids[ids.length - 1]).toBe('glm-4.6v-flash');
    // 用户自添模型（不在 preset 内）排预设模型之后
    upsertProviderModel(p.id, 'glm-custom-9');
    const withCustom = listProviderModels(p.id).map((m) => m.modelId);
    expect(withCustom[withCustom.length - 1]).toBe('glm-custom-9');
  });

  it('D12：无 preset 供应商保持 added_at 序（不受 preset 排序影响）', async () => {
    runMigrations();
    const p = await createProvider({ name: 'C', baseUrl: 'u', apiKey: 'k' });
    upsertProviderModel(p.id, 'm-early');
    upsertProviderModel(p.id, 'm-late');
    const ids = listProviderModels(p.id).map((m) => m.modelId);
    expect(ids.indexOf('m-early')).toBeLessThan(ids.indexOf('m-late'));
  });
});
