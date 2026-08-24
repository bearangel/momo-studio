// electron/tests/agent/definition-default-model.test.ts
//
// P3 Task 2：createCustomDef 会话模型 fallback 消费测试。
//
// 场景矩阵（4 个）：
// ① no provider given + global defaultChatModel set + provider row exists → 落库 def.modelProviderId/modelName = 引用值
// ② global default set but provider row missing → 抛「未配置 provider」类错误
// ③ no global default + no provider given → 抛「未配置 provider」类错误
// ④ provider explicitly given → 不消费 defaultChatModel，原值落库
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import {
  createCustomDef,
  listAgentDefinitions,
} from '../../src/main/agent/crud';
import { updateGlobalSettings } from '../../src/main/settings/crud';
import {
  createProvider,
} from '../../src/main/agent/provider-crud';
import type { AgentDefinition } from '../../src/main/agent/types';

// runtime-status / runtime-registry 在 crud-custom-def 测试里也 mock 掉，保持一致
vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  stopAgentRuntime: vi.fn(),
}));

const tmpRoot = path.join(os.tmpdir(), `ap-def-default-model-${Date.now()}`);
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

/** 通过 slug 从 listAgentDefinitions 找到刚创建的 def（id 是 randomUUID） */
function findBySlug(slug: string): AgentDefinition {
  const match = listAgentDefinitions().find((d) => d.slug === slug);
  if (!match) throw new Error(`未找到 slug=${slug} 的 def`);
  return match;
}

describe('createCustomDef — defaultChatModel 兜底消费（P3 Task 2）', () => {
  it('① 全局设了 defaultChatModel 且供应商存在 + 未传 provider → 落库引用值', async () => {
    const provider = await createProvider({
      name: 'GLM', baseUrl: 'https://example/v1', apiKey: 'k',
    });
    updateGlobalSettings({
      defaultChatModel: { providerId: provider.id, modelId: 'glm-5.3' },
    });

    const def = createCustomDef(null, {
      name: 'A1', slug: 'a1', systemPrompt: 'p',
      // 故意不传 modelProviderId（TS 强制要求 string，给空串模拟 UI 未填）
      modelProviderId: '', modelName: '',
    });

    expect(def.modelProviderId).toBe(provider.id);
    expect(def.modelName).toBe('glm-5.3');
    // 落库后的查询同样反映兜底结果
    const reloaded = findBySlug('a1');
    expect(reloaded.modelProviderId).toBe(provider.id);
    expect(reloaded.modelName).toBe('glm-5.3');
  });

  it('② 全局设了 defaultChatModel 但供应商行已被删 → 抛「未配置 provider」类错误', async () => {
    // 关键差异：未在 DB 里建供应商，但 defaultChatModel 引用了一个不存在的 providerId
    updateGlobalSettings({
      defaultChatModel: { providerId: 'ghost-provider', modelId: 'glm-5.3' },
    });

    expect(() => createCustomDef(null, {
      name: 'A2', slug: 'a2', systemPrompt: 'p',
      modelProviderId: '', modelName: '',
    })).toThrow(/未配置 modelProviderId/);

    // 落库为空——确保 throw 路径不会写入脏数据
    expect(listAgentDefinitions().find((d) => d.slug === 'a2')).toBeUndefined();
  });

  it('③ 未设 defaultChatModel 且未传 provider → 抛「未配置 provider」类错误', () => {
    expect(() => createCustomDef(null, {
      name: 'A3', slug: 'a3', systemPrompt: 'p',
      modelProviderId: '', modelName: '',
    })).toThrow(/未配置 modelProviderId/);

    expect(listAgentDefinitions().find((d) => d.slug === 'a3')).toBeUndefined();
  });

  it('④ 显式传 provider 时不消费 defaultChatModel → 原值落库', async () => {
    // 即使 defaultChatModel 指向另一个供应商，传入的 explicit 值应优先
    const defaultProvider = await createProvider({
      name: 'DefaultProv', baseUrl: 'https://default/v1', apiKey: 'kd',
    });
    const explicitProvider = await createProvider({
      name: 'ExplicitProv', baseUrl: 'https://explicit/v1', apiKey: 'ke',
    });
    updateGlobalSettings({
      defaultChatModel: { providerId: defaultProvider.id, modelId: 'default-model' },
    });

    const def = createCustomDef(null, {
      name: 'A4', slug: 'a4', systemPrompt: 'p',
      modelProviderId: explicitProvider.id, modelName: 'explicit-model',
    });

    expect(def.modelProviderId).toBe(explicitProvider.id);
    expect(def.modelName).toBe('explicit-model');

    const reloaded = findBySlug('a4');
    expect(reloaded.modelProviderId).toBe(explicitProvider.id);
    expect(reloaded.modelName).toBe('explicit-model');
  });
});