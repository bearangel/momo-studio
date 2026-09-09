// electron/tests/agent/provider-crud-presets.test.ts
//
// migration v31 三列 + 预设种子 + thinking_json 读写 + listModels 富化（spec §3/§6/§7.2）。
// DB 隔离沿用仓库既定模式：AP_USER_DATA_DIR 临时目录 + getDb() 单例 + closeDb() 复位。
// keychain mock：createProvider 走 setSecret，测试环境无 keytar。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/main/storage/keychain', () => ({
  setSecret: vi.fn(async () => undefined),
  getSecret: vi.fn(async () => null),
  deleteSecret: vi.fn(async () => undefined),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  createProvider,
  listProviders,
  listProviderModels,
  setProviderModelThinking,
  seedPresetModels,
} from '../../src/main/agent/provider-crud';

const tmpRoot = path.join(os.tmpdir(), `ap-provider-presets-${Date.now()}-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('migration v31：三列可空，老行零破坏', () => {
  it('直接 SQL 插入老形状 provider 行可读回 presetKey=null', () => {
    getDb().prepare(
      `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default, platform)
       VALUES ('p1', 'T', 'https://api.test.com', 'ref', NULL, 0, 'openai')`,
    ).run();
    expect(listProviders()[0]!.presetKey).toBeNull();
  });
});

describe('createProvider(presetKey)：种子模型幂等写入', () => {
  it('预设模型全部 enabled 落库；context_window 列保持 NULL；重复种子不覆盖用户改动', async () => {
    const p = await createProvider({
      name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'k', platform: 'openai', presetKey: 'zhipu',
    });
    expect(p.presetKey).toBe('zhipu');
    const models = listProviderModels(p.id);
    expect(models.map((m) => m.modelId)).toContain('glm-5.3');
    expect(models.every((m) => m.enabled)).toBe(true);
    // 种子行 context_window 列保持 NULL（走预设表 resolve，spec §2.2）
    expect(models.find((m) => m.modelId === 'glm-5.3')!.contextWindow).toBeNull();

    // 用户禁用某模型后重跑种子：不覆盖（INSERT OR IGNORE 幂等）
    getDb().prepare(
      `UPDATE provider_models SET enabled = 0 WHERE provider_id = ? AND model_id = 'glm-4.6'`,
    ).run(p.id);
    seedPresetModels(p.id, 'zhipu');
    expect(listProviderModels(p.id).find((m) => m.modelId === 'glm-4.6')!.enabled).toBe(false);
  });

  it('未知 presetKey 抛错', () => {
    expect(() => seedPresetModels('p-x', 'nope')).toThrow(/未知供应商预设/);
  });

  it('未知 presetKey 在写库前拒绝——不留孤儿行', async () => {
    await expect(
      createProvider({ name: 'T', baseUrl: 'https://api.test.com', apiKey: 'k', platform: 'openai', presetKey: 'nope' }),
    ).rejects.toThrow(/未知供应商预设/);
    expect((await import('../../src/main/agent/provider-crud')).listProviders()).toHaveLength(0);
  });
});

describe('setProviderModelThinking：形状校验与读写往返', () => {
  it('合法配置落库并可读回；null 清除；非法 mode 拒绝', async () => {
    const p = await createProvider({ name: 'T', baseUrl: 'https://api.test.com', apiKey: 'k', platform: 'openai' });
    getDb().prepare(
      `INSERT INTO provider_models (provider_id, model_id, enabled, added_at) VALUES (?, 'glm-5.3', 1, 1)`,
    ).run(p.id);

    setProviderModelThinking(p.id, 'glm-5.3', { mode: 'on', effort: 'high' });
    expect(listProviderModels(p.id)[0]!.thinkingJson).toEqual({ mode: 'on', effort: 'high' });

    setProviderModelThinking(p.id, 'glm-5.3', null);
    expect(listProviderModels(p.id)[0]!.thinkingJson).toBeNull();

    expect(() => setProviderModelThinking(p.id, 'glm-5.3', { mode: 'bad' as 'on', effort: null })).toThrow();
  });
});

describe('listProviderModels 富化：reasoning + effectiveWindow（服务端单点 resolve，spec §6）', () => {
  it('预设供应商：presetKey 命中预设表能力；effectiveWindow 走预设数字', async () => {
    const p = await createProvider({
      name: 'T', baseUrl: 'https://api.test.com', apiKey: 'k',
      platform: 'openai', presetKey: 'moonshot',
    });
    const k3 = listProviderModels(p.id).find((m) => m.modelId === 'kimi-k3')!;
    expect(k3.reasoning).toEqual({ kind: 'effort', values: ['low', 'high', 'max'], default: 'max' });
    expect(k3.effectiveWindow).toBe(1_000_000);
  });

  it('自定义供应商：无 presetKey → 正则目录兜底；未知模型 → none / null', async () => {
    const p = await createProvider({ name: 'T', baseUrl: 'https://api.test.com', apiKey: 'k', platform: 'openai' });
    getDb().prepare(
      `INSERT INTO provider_models (provider_id, model_id, enabled, added_at) VALUES (?, 'glm-4.6', 1, 1)`,
    ).run(p.id);
    getDb().prepare(
      `INSERT INTO provider_models (provider_id, model_id, enabled, added_at) VALUES (?, 'my-model', 1, 2)`,
    ).run(p.id);
    const models = listProviderModels(p.id);
    expect(models.find((m) => m.modelId === 'glm-4.6')!.reasoning).toEqual({ kind: 'toggle' });
    expect(models.find((m) => m.modelId === 'glm-4.6')!.effectiveWindow).toBe(200_000);
    expect(models.find((m) => m.modelId === 'my-model')!.reasoning).toEqual({ kind: 'none' });
    expect(models.find((m) => m.modelId === 'my-model')!.effectiveWindow).toBeNull();
  });

  it('用户覆盖列优先于预设表（effectiveWindow）', async () => {
    const p = await createProvider({
      name: 'T', baseUrl: 'https://api.test.com', apiKey: 'k',
      platform: 'openai', presetKey: 'zhipu',
    });
    getDb().prepare(
      `UPDATE provider_models SET context_window = 131072 WHERE provider_id = ? AND model_id = 'glm-4.6'`,
    ).run(p.id);
    expect(listProviderModels(p.id).find((m) => m.modelId === 'glm-4.6')!.effectiveWindow).toBe(131_072);
  });
});
