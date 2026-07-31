// updateAgentDefinition + updateAgentApiKey + listRunningInstanceIdsByDefinition 单测
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import {
  saveAgentDefinition, getAgentDefinition,
  assignAgentToWorkspace,
  updateAgentDefinition, listRunningInstanceIdsByDefinition, updateAgentApiKey,
} from '../../src/main/agent/crud';
// createWorkspace 实际定义在 workspace/crud，不在 agent/crud（brief 笔误）
import { createWorkspace } from '../../src/main/workspace/crud';

// mock runtime-manager（避免真实子进程）
vi.mock('../../src/main/agent/runtime-manager', () => ({
  isAgentRunning: vi.fn(() => false),
  stopAgent: vi.fn(),
}));

const tmpRoot = path.join(os.tmpdir(), `ap-crud-update-${Date.now()}`);
const memStore = new Map<string, string>();
// 注意：KeychainImpl 实际接口是 setSecret(key,value)/getSecret(key)/deleteSecret(key)（2 参），
// 不是 keytar 原生 setPassword(service,key,value)（3 参）。
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

// sampleDef 构建 def-1 并落库后返回持久化对象（saveAgentDefinition 返回 void）
const sampleDef = () => {
  saveAgentDefinition({
    id: 'def-1', name: 'Agent', slug: 'agent', version: '1.0', type: 'standalone',
    runtime: 'declarative', systemPrompt: '原 prompt',
    model: { provider: 'openai', model: 'gpt-4o' },
    defaultTools: [], source: 'custom', description: 'd', iconEmoji: '🤖',
    defaultMcps: [], defaultSkills: [],
  });
  return getAgentDefinition('def-1')!;
};

describe('updateAgentDefinition', () => {
  it('更新指定字段，未传字段保留原值', () => {
    sampleDef();
    const updated = updateAgentDefinition({ id: 'def-1', name: '新名', systemPrompt: '新 prompt' });
    expect(updated.name).toBe('新名');
    expect(updated.systemPrompt).toBe('新 prompt');
    expect(updated.slug).toBe('agent'); // 未传保留
  });

  it('modelBaseUrl 传空字符串清空', () => {
    sampleDef();
    const updated = updateAgentDefinition({ id: 'def-1', modelBaseUrl: '' });
    expect(updated.model.baseUrl).toBe('');
  });

  it('不存在的 id 抛错', () => {
    expect(() => updateAgentDefinition({ id: 'nope', name: 'x' })).toThrow();
  });
});

describe('listRunningInstanceIdsByDefinition', () => {
  it('返回该 def 的全部 assignment instanceId（运行状态由调用方过滤）', async () => {
    const def = sampleDef();
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' }, '@o:localhost', '!s:localhost', '!t:localhost',
    );
    assignAgentToWorkspace(ws.id, def.id, '@bot1:localhost');
    assignAgentToWorkspace(ws.id, def.id, '@bot2:localhost');
    const ids = listRunningInstanceIdsByDefinition(def.id);
    expect(ids).toHaveLength(2);
  });

  it('其它 def 的 assignment 不计入', async () => {
    const def1 = sampleDef();
    saveAgentDefinition({
      id: 'def-2', name: 'B', slug: 'b', version: '1.0', type: 'standalone',
      runtime: 'declarative', systemPrompt: 'p',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'custom', description: 'd', iconEmoji: '🤖',
      defaultMcps: [], defaultSkills: [],
    });
    const def2 = getAgentDefinition('def-2')!;
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' }, '@o:localhost', '!s:localhost', '!t:localhost',
    );
    assignAgentToWorkspace(ws.id, def1.id, '@bot1:localhost');
    assignAgentToWorkspace(ws.id, def2.id, '@bot2:localhost');
    expect(listRunningInstanceIdsByDefinition(def1.id)).toHaveLength(1);
  });
});

describe('updateAgentApiKey', () => {
  it('写入实例 keychain 槽 agent.<instanceId>.llm_api_key', async () => {
    const def = sampleDef();
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' }, '@o:localhost', '!s:localhost', '!t:localhost',
    );
    const assignment = assignAgentToWorkspace(ws.id, def.id, '@bot1:localhost');
    await updateAgentApiKey(assignment.instanceId, 'new-secret');
    expect(memStore.get(`agent.${assignment.instanceId}.llm_api_key`)).toBe('new-secret');
  });
});
