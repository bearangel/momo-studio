// electron/tests/agent/crud-update.test.ts
// updateAgentDefinition + updateAgentApiKey + listRunningInstanceIdsByDefinition 单测
// v25：agent_definitions.workspace_id 列已 DROP（定义恒全局），scope 绑定断言随语义退役。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import {
  saveAgentDefinition,
  getAgentDefinition,
  addMember,
  updateAgentDefinition,
  listRunningInstanceIdsByDefinition,
  updateAgentApiKey,
} from '../../src/main/agent/crud';
import { createWorkspace } from '../../src/main/workspace/crud';

vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  stopAgentRuntime: vi.fn(),
}));

const tmpRoot = path.join(os.tmpdir(), `ap-crud-update-${Date.now()}`);
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

/** 构建 def-1 并落库后返回持久化对象 */
const sampleDef = () => {
  saveAgentDefinition({
    id: 'def-1', name: 'Agent', slug: 'agent', version: '1.0',
    runtime: 'declarative', systemPrompt: '原 prompt',
    defaultTools: [], source: 'custom', description: 'd', iconEmoji: '🤖',
    defaultMcps: [], defaultSkills: [],
    workspaceId: null, modelProviderId: 'prov-1', modelName: 'gpt-4o',
  });
  return getAgentDefinition('def-1')!;
};

describe('updateAgentDefinition — v25 定义全局化', () => {
  it('更新指定字段，未传字段保留原值', () => {
    sampleDef();
    const updated = updateAgentDefinition({ id: 'def-1', name: '新名', systemPrompt: '新 prompt' });
    expect(updated.name).toBe('新名');
    expect(updated.systemPrompt).toBe('新 prompt');
    expect(updated.slug).toBe('agent'); // 未传保留
  });

  it('更新 modelProviderId 和 modelName', () => {
    sampleDef();
    const updated = updateAgentDefinition({
      id: 'def-1',
      modelProviderId: 'prov-2',
      modelName: 'claude-3',
    });
    expect(updated.modelProviderId).toBe('prov-2');
    expect(updated.modelName).toBe('claude-3');
  });

  it('workspaceId 不再持久化：v25 定义恒全局（列已 DROP），更新后恒为 null', () => {
    sampleDef();
    const updated = updateAgentDefinition({ id: 'def-1', name: '改名' });
    expect(updated.workspaceId).toBeNull();
  });

  it('不存在的 id 抛错', () => {
    expect(() => updateAgentDefinition({ id: 'nope', name: 'x' })).toThrow();
  });
});

describe('listRunningInstanceIdsByDefinition', () => {
  it('返回该 def 的全部成员 instanceId（跨 ws 多成员）', async () => {
    const def = sampleDef();
    // v25：同 ws 同 def 唯一——双成员需分布在两个 ws
    const ws1 = await createWorkspace(
      { name: 'w1', description: '', directoryPath: path.join(tmpRoot, 'ws1'), iconEmoji: '📁' },
      '@o:localhost',
    );
    const ws2 = await createWorkspace(
      { name: 'w2', description: '', directoryPath: path.join(tmpRoot, 'ws2'), iconEmoji: '📁' },
      '@o:localhost',
    );
    await addMember(ws1.id, def.id, '@bot1:localhost');
    await addMember(ws2.id, def.id, '@bot2:localhost');
    const ids = listRunningInstanceIdsByDefinition(def.id);
    expect(ids).toHaveLength(2);
  });

  it('其它 def 的成员不计入', async () => {
    const def1 = sampleDef();
    saveAgentDefinition({
      id: 'def-2', name: 'B', slug: 'b', version: '1.0',
      runtime: 'declarative', systemPrompt: 'p',
      defaultTools: [], source: 'custom', description: 'd', iconEmoji: '🤖',
      defaultMcps: [], defaultSkills: [],
      workspaceId: null, modelProviderId: 'prov-1', modelName: 'gpt-4o',
    });
    const def2 = getAgentDefinition('def-2')!;
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost',
    );
    await addMember(ws.id, def1.id, '@bot1:localhost');
    await addMember(ws.id, def2.id, '@bot2:localhost');
    expect(listRunningInstanceIdsByDefinition(def1.id)).toHaveLength(1);
  });
});

describe('updateAgentApiKey (legacy)', () => {
  it('写入实例 keychain 槽 agent.<instanceId>.llm_api_key', async () => {
    const def = sampleDef();
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost',
    );
    const member = await addMember(ws.id, def.id, '@bot1:localhost');
    await updateAgentApiKey(member.instanceId, 'new-secret');
    expect(memStore.get(`agent.${member.instanceId}.llm_api_key`)).toBe('new-secret');
  });
});

describe('stopRunningInstancesByDefinition', () => {
  it('isAgentRunning=true 时停止并加入返回列表', async () => {
    const { isAgentRunning } = await import('../../src/main/agent/runtime-status');
    const { stopAgentRuntime } = await import('../../src/main/agent/runtime-registry');
    vi.mocked(isAgentRunning).mockImplementation(() => true);
    vi.mocked(stopAgentRuntime).mockClear();

    const def = sampleDef();
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost',
    );
    await addMember(ws.id, def.id, '@bot:localhost');

    const { stopRunningInstancesByDefinition } = await import('../../src/main/agent/crud');
    const stopped = await stopRunningInstancesByDefinition(def.id);
    expect(stopped).toHaveLength(1);
    expect(stopAgentRuntime).toHaveBeenCalledTimes(1);
  });

  it('isAgentRunning=false 时不停止', async () => {
    const { isAgentRunning } = await import('../../src/main/agent/runtime-status');
    const { stopAgentRuntime } = await import('../../src/main/agent/runtime-registry');
    vi.mocked(isAgentRunning).mockImplementation(() => false);
    vi.mocked(stopAgentRuntime).mockClear();

    const def = sampleDef();
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost',
    );
    await addMember(ws.id, def.id, '@bot:localhost');

    const { stopRunningInstancesByDefinition } = await import('../../src/main/agent/crud');
    const stopped = await stopRunningInstancesByDefinition(def.id);
    expect(stopped).toHaveLength(0);
    expect(stopAgentRuntime).not.toHaveBeenCalled();
  });
});
