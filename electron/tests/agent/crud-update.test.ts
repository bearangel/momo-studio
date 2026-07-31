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

  it('modelBaseUrl 不传时保留原 NULL（不漂移为空串）', () => {
    saveAgentDefinition({
      id: 'def-null-base', name: 'NullBase', slug: 'null-base', version: '1.0', type: 'standalone',
      runtime: 'declarative', systemPrompt: 'p',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'custom', description: 'd', iconEmoji: '🤖',
      defaultMcps: [], defaultSkills: [],
    });
    const updated = updateAgentDefinition({ id: 'def-null-base', name: '新名' });
    expect(updated.model.baseUrl).toBeUndefined();
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

describe('updateAgentDefinition — type + parentAgentId', () => {
  it('更新 type 为 main', () => {
    sampleDef(); // def-1 是 standalone
    const updated = updateAgentDefinition({ id: 'def-1', type: 'main' });
    expect(updated.type).toBe('main');
  });

  it('更新 type 为 sub 并设 parentAgentId', () => {
    // 先创建 main def
    saveAgentDefinition({
      id: 'main-def', name: 'Main', slug: 'main-def', version: '1.0', type: 'main',
      runtime: 'declarative', systemPrompt: 'p',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'custom', description: 'd', iconEmoji: '🤖',
      defaultMcps: [], defaultSkills: [],
    });
    sampleDef(); // def-1 是 standalone
    const updated = updateAgentDefinition({ id: 'def-1', type: 'sub', parentAgentId: 'main-def' });
    expect(updated.type).toBe('sub');
    expect(updated.parentAgentId).toBe('main-def');
  });

  it('更新 type 为 standalone 时清除 parentAgentId', () => {
    // 先把 def-1 设为 sub
    saveAgentDefinition({
      id: 'main-def', name: 'Main', slug: 'main-def', version: '1.0', type: 'main',
      runtime: 'declarative', systemPrompt: 'p',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'custom', description: 'd', iconEmoji: '🤖',
      defaultMcps: [], defaultSkills: [],
    });
    sampleDef();
    updateAgentDefinition({ id: 'def-1', type: 'sub', parentAgentId: 'main-def' });
    // 再改回 standalone
    const updated = updateAgentDefinition({ id: 'def-1', type: 'standalone' });
    expect(updated.type).toBe('standalone');
    expect(updated.parentAgentId).toBeUndefined();
  });

  it('不传 type 时保留原 type', () => {
    sampleDef();
    updateAgentDefinition({ id: 'def-1', type: 'main' });
    const updated = updateAgentDefinition({ id: 'def-1', name: '新名' });
    expect(updated.type).toBe('main');
  });
});

describe('stopRunningInstancesByDefinition', () => {
  it('isAgentRunning=true 时停止并加入返回列表', async () => {
    const { isAgentRunning, stopAgent } = await import('../../src/main/agent/runtime-manager');
    vi.mocked(isAgentRunning).mockImplementation(() => true);
    vi.mocked(stopAgent).mockClear();

    const def = sampleDef();
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost', '!s:localhost', '!t:localhost',
    );
    assignAgentToWorkspace(ws.id, def.id, '@bot:localhost');

    const { stopRunningInstancesByDefinition } = await import('../../src/main/agent/crud');
    const stopped = stopRunningInstancesByDefinition(def.id);
    expect(stopped).toHaveLength(1);
    expect(stopAgent).toHaveBeenCalledTimes(1);
  });

  it('isAgentRunning=false 时不停止', async () => {
    const { isAgentRunning, stopAgent } = await import('../../src/main/agent/runtime-manager');
    vi.mocked(isAgentRunning).mockImplementation(() => false);
    vi.mocked(stopAgent).mockClear();

    const def = sampleDef();
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost', '!s:localhost', '!t:localhost',
    );
    assignAgentToWorkspace(ws.id, def.id, '@bot:localhost');

    const { stopRunningInstancesByDefinition } = await import('../../src/main/agent/crud');
    const stopped = stopRunningInstancesByDefinition(def.id);
    expect(stopped).toHaveLength(0);
    expect(stopAgent).not.toHaveBeenCalled();
  });
});
