// electron/tests/agent/crud-update.test.ts
// updateAgentDefinition + updateAgentApiKey + listRunningInstanceIdsByDefinition 单测
// v1.3 schema：AgentDefinition 无 type/parent/model；新增 workspaceId/modelProviderId/modelName
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import {
  saveAgentDefinition,
  getAgentDefinition,
  assignAgentToWorkspace,
  updateAgentDefinition,
  listRunningInstanceIdsByDefinition,
  updateAgentApiKey,
} from '../../src/main/agent/crud';
import { createWorkspace } from '../../src/main/workspace/crud';

vi.mock('../../src/main/agent/runtime-manager', () => ({
  isAgentRunning: vi.fn(() => false),
  stopAgent: vi.fn(),
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

describe('updateAgentDefinition — v1.3 schema', () => {
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

  it('workspaceId 显式传 null 转 global', () => {
    // 先建一个 workspace-scoped def
    saveAgentDefinition({
      id: 'def-ws', name: 'WS', slug: 'ws', version: '1.0',
      runtime: 'declarative', systemPrompt: 'p',
      defaultTools: [], source: 'custom', description: 'd', iconEmoji: '🤖',
      defaultMcps: [], defaultSkills: [],
      workspaceId: 'ws-1', modelProviderId: 'prov-1', modelName: 'gpt-4o',
    });
    const updated = updateAgentDefinition({ id: 'def-ws', workspaceId: null });
    expect(updated.workspaceId).toBeNull();
  });

  it('workspaceId 传字符串绑定该 workspace', () => {
    sampleDef(); // def-1 默认 global
    const updated = updateAgentDefinition({ id: 'def-1', workspaceId: 'ws-new' });
    expect(updated.workspaceId).toBe('ws-new');
  });

  it('workspaceId 不传时保留原值', () => {
    saveAgentDefinition({
      id: 'def-ws', name: 'WS', slug: 'ws', version: '1.0',
      runtime: 'declarative', systemPrompt: 'p',
      defaultTools: [], source: 'custom', description: 'd', iconEmoji: '🤖',
      defaultMcps: [], defaultSkills: [],
      workspaceId: 'ws-1', modelProviderId: 'prov-1', modelName: 'gpt-4o',
    });
    const updated = updateAgentDefinition({ id: 'def-ws', name: '改名' });
    expect(updated.workspaceId).toBe('ws-1');
  });

  it('不存在的 id 抛错', () => {
    expect(() => updateAgentDefinition({ id: 'nope', name: 'x' })).toThrow();
  });
});

describe('listRunningInstanceIdsByDefinition', () => {
  it('返回该 def 的全部 assignment instanceId', async () => {
    const def = sampleDef();
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost', '!s:localhost', '!t:localhost',
    );
    assignAgentToWorkspace(ws.id, def.id, '@bot1:localhost');
    assignAgentToWorkspace(ws.id, def.id, '@bot2:localhost');
    const ids = listRunningInstanceIdsByDefinition(def.id);
    expect(ids).toHaveLength(2);
  });

  it('其它 def 的 assignment 不计入', async () => {
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
      '@o:localhost', '!s:localhost', '!t:localhost',
    );
    assignAgentToWorkspace(ws.id, def1.id, '@bot1:localhost');
    assignAgentToWorkspace(ws.id, def2.id, '@bot2:localhost');
    expect(listRunningInstanceIdsByDefinition(def1.id)).toHaveLength(1);
  });
});

describe('updateAgentApiKey (legacy)', () => {
  it('写入实例 keychain 槽 agent.<instanceId>.llm_api_key', async () => {
    const def = sampleDef();
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost', '!s:localhost', '!t:localhost',
    );
    const assignment = assignAgentToWorkspace(ws.id, def.id, '@bot1:localhost');
    await updateAgentApiKey(assignment.instanceId, 'new-secret');
    expect(memStore.get(`agent.${assignment.instanceId}.llm_api_key`)).toBe('new-secret');
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
