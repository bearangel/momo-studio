// electron/tests/agent/crud-assignment.test.ts
// v25 清账：role/parent/循环引用/listSubAssignments 断言的是已退役编排行为，
// 已删除（成员制覆盖见 membership-crud.test.ts / team-crud.test.ts）。
// 本文件保留三块新语义下仍有效的覆盖：
//   1. updateAssignmentApiKey —— override 更新路径（agent:setMemberApiKeyOverride 消费）
//   2. deleteDefinition —— builtin 守卫 + 级联清理成员行 + keychain
//   3. lastRunning 字段映射 —— row → WorkspaceAgentMember.lastRunning
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import {
  saveAgentDefinition,
  addMember,
  updateAssignmentApiKey,
  listMembers,
  deleteDefinition,
} from '../../src/main/agent/crud';
import { createWorkspace } from '../../src/main/workspace/crud';
import type { AgentDefinition } from '../../src/main/agent/types';

vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  stopAgentRuntime: vi.fn(),
}));

const tmpRoot = path.join(os.tmpdir(), `ap-crud-assignment-${Date.now()}`);
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};

let wsId: string;

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
  const ws = await createWorkspace(
    { name: 'WS', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
    '@u:localhost',
  );
  wsId = ws.id;
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

function makeDef(id: string): AgentDefinition {
  return {
    id, name: id, slug: id, version: '1', runtime: 'declarative',
    systemPrompt: '', defaultTools: [], source: 'custom',
    description: '', iconEmoji: '🤖',
    defaultMcps: [], defaultSkills: [],
    workspaceId: null, modelProviderId: 'prov-1', modelName: 'gpt-4o',
  };
}

describe('updateAssignmentApiKey — override 标志 + keychain', () => {
  beforeEach(() => {
    saveAgentDefinition(makeDef('def-1'));
  });

  it('非空 apiKey 写 keychain + 置 has_api_key_override=1', async () => {
    const a = await addMember(wsId, 'def-1', '@a:localhost');
    await updateAssignmentApiKey(a.instanceId, 'sk-xxx');
    expect(memStore.get(`agent.${a.instanceId}.api_key_override`)).toBe('sk-xxx');
    const updated = listMembers(wsId).find((x) => x.instanceId === a.instanceId);
    expect(updated?.hasApiKeyOverride).toBe(true);
  });

  it('apiKey=null 清除 override（keychain + DB 标志）', async () => {
    const a = await addMember(wsId, 'def-1', '@a:localhost');
    await updateAssignmentApiKey(a.instanceId, 'sk-xxx');
    await updateAssignmentApiKey(a.instanceId, null);
    expect(memStore.has(`agent.${a.instanceId}.api_key_override`)).toBe(false);
    const updated = listMembers(wsId).find((x) => x.instanceId === a.instanceId);
    expect(updated?.hasApiKeyOverride).toBe(false);
  });
});

describe('deleteDefinition — 级联清理', () => {
  it('builtin 不可删', async () => {
    saveAgentDefinition({ ...makeDef('b-1'), source: 'builtin' });
    await expect(deleteDefinition('b-1')).rejects.toThrow(/builtin/);
  });

  it('custom def 级联清理成员行 + def 行', async () => {
    saveAgentDefinition(makeDef('c-1'));
    // 同 def 双 ws 各一成员（v25：同 ws 同 def 唯一，跨 ws 合法）
    const ws2 = await createWorkspace(
      { name: 'WS2', description: '', directoryPath: path.join(tmpRoot, 'ws2'), iconEmoji: '📁' },
      '@u:localhost',
    );
    await addMember(wsId, 'c-1', '@b1:localhost');
    await addMember(ws2.id, 'c-1', '@b2:localhost');
    expect(listMembers(wsId)).toHaveLength(1);
    expect(listMembers(ws2.id)).toHaveLength(1);

    await deleteDefinition('c-1');

    // def 行删除
    const { getAgentDefinition } = await import('../../src/main/agent/crud');
    expect(getAgentDefinition('c-1')).toBeNull();
    // 成员行级联清理
    expect(listMembers(wsId)).toHaveLength(0);
    expect(listMembers(ws2.id)).toHaveLength(0);
  });

  it('清 has_api_key_override 的成员时同时清 keychain', async () => {
    saveAgentDefinition(makeDef('c-1'));
    const a = await addMember(wsId, 'c-1', '@b:localhost');
    await updateAssignmentApiKey(a.instanceId, 'sk-xxx');
    expect(memStore.has(`agent.${a.instanceId}.api_key_override`)).toBe(true);

    await deleteDefinition('c-1');
    expect(memStore.has(`agent.${a.instanceId}.api_key_override`)).toBe(false);
  });
});

/**
 * rowToMember 必须把 DB 列 last_running 映射到 WorkspaceAgentMember.lastRunning
 * （boolean；「agent 在线」的唯一权威源，init-runtime 恢复过滤消费）。
 */
describe('WorkspaceAgentMember.lastRunning 字段映射', () => {
  function makeIsolatedWs(prefix: string): string {
    const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    getDb()
      .prepare(
        `INSERT INTO workspaces (id, name, owner_id, directory_path)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, 'test', '@owner:localhost', '/tmp');
    return id;
  }

  it('row.last_running=1 → member.lastRunning=true', async () => {
    const localWsId = makeIsolatedWs('ws-test-last-running');
    saveAgentDefinition(makeDef('def-lr-1'));
    await addMember(localWsId, 'def-lr-1', '@bot1:localhost');

    getDb()
      .prepare('UPDATE workspace_agent_members SET last_running = 1 WHERE workspace_id = ?')
      .run(localWsId);

    const list = listMembers(localWsId);
    expect(list).toHaveLength(1);
    expect(list[0].lastRunning).toBe(true);
  });

  it('row.last_running=0 → member.lastRunning=false', async () => {
    const localWsId = makeIsolatedWs('ws-test-last-running-off');
    saveAgentDefinition(makeDef('def-lr-2'));
    await addMember(localWsId, 'def-lr-2', '@bot2:localhost');

    getDb()
      .prepare('UPDATE workspace_agent_members SET last_running = 0 WHERE workspace_id = ?')
      .run(localWsId);

    const list = listMembers(localWsId);
    expect(list).toHaveLength(1);
    expect(list[0].lastRunning).toBe(false);
  });
});
