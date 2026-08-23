// electron/tests/agent/crud-assignment.test.ts
// assignment CRUD：role/parent/循环引用/级联删除（v1.3 schema）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import {
  saveAgentDefinition,
  assignAgentToWorkspace,
  updateAssignmentRole,
  updateAssignmentApiKey,
  listSubAssignments,
  listAssignments,
  deleteDefinition,
} from '../../src/main/agent/crud';
import { createWorkspace } from '../../src/main/workspace/crud';
import type { AgentDefinition } from '../../src/main/agent/types';

vi.mock('../../src/main/agent/runtime-manager', () => ({
  isAgentRunning: vi.fn(() => false),
  stopAgent: vi.fn(),
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
    '@u:localhost', '!s:localhost', '!t:localhost',
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

describe('assignAgentToWorkspace — role + parent', () => {
  beforeEach(() => {
    saveAgentDefinition(makeDef('def-1'));
  });

  it('写 role=main + parent_instance_id=NULL', () => {
    const a = assignAgentToWorkspace(wsId, 'def-1', '@m:localhost', 'main');
    expect(a.role).toBe('main');
    expect(a.parentInstanceId).toBeNull();
  });

  it('写 role=sub + parent_instance_id=指定 main', () => {
    saveAgentDefinition(makeDef('def-2'));
    const main = assignAgentToWorkspace(wsId, 'def-1', '@m:localhost', 'main');
    const sub = assignAgentToWorkspace(wsId, 'def-2', '@s:localhost', 'sub', main.instanceId);
    expect(sub.role).toBe('sub');
    expect(sub.parentInstanceId).toBe(main.instanceId);
  });

  it("role='sub' 时 parentInstanceId 必填", () => {
    expect(() => assignAgentToWorkspace(wsId, 'def-1', '@x:localhost', 'sub')).toThrow(/parentInstanceId/);
  });

  it("role!='sub' 时 parentInstanceId 必须为 NULL（传值抛错）", () => {
    saveAgentDefinition(makeDef('def-2'));
    const other = assignAgentToWorkspace(wsId, 'def-2', '@o:localhost', 'standalone');
    expect(() =>
      assignAgentToWorkspace(wsId, 'def-1', '@x:localhost', 'standalone', other.instanceId),
    ).toThrow(/不可有 parentInstanceId/);
  });
});

describe('updateAssignmentRole — 循环引用检测', () => {
  beforeEach(() => {
    saveAgentDefinition(makeDef('def-1'));
    saveAgentDefinition(makeDef('def-2'));
    saveAgentDefinition(makeDef('def-3'));
  });

  it('改 role + parent', () => {
    const main = assignAgentToWorkspace(wsId, 'def-1', '@m:localhost', 'main');
    const sub = assignAgentToWorkspace(wsId, 'def-2', '@s:localhost', 'standalone');
    updateAssignmentRole(sub.instanceId, 'sub', main.instanceId);
    const updated = listAssignments(wsId).find((a) => a.instanceId === sub.instanceId);
    expect(updated?.role).toBe('sub');
    expect(updated?.parentInstanceId).toBe(main.instanceId);
  });

  it('检测直接循环（自己当父）', () => {
    const a = assignAgentToWorkspace(wsId, 'def-1', '@a:localhost', 'standalone');
    expect(() => updateAssignmentRole(a.instanceId, 'sub', a.instanceId)).toThrow(/循环引用/);
  });

  it('检测间接循环（a→b→c→a）', () => {
    const a = assignAgentToWorkspace(wsId, 'def-1', '@a:localhost', 'main');
    const b = assignAgentToWorkspace(wsId, 'def-2', '@b:localhost', 'sub', a.instanceId);
    const c = assignAgentToWorkspace(wsId, 'def-3', '@c:localhost', 'sub', b.instanceId);
    // 把 a 改成 c 的 sub → 形成环 a→c→b→a
    expect(() => updateAssignmentRole(a.instanceId, 'sub', c.instanceId)).toThrow(/循环引用/);
  });

  it("role!=sub 时强制 parentInstanceId=NULL（传值会被清空）", () => {
    const main = assignAgentToWorkspace(wsId, 'def-1', '@m:localhost', 'main');
    const sub = assignAgentToWorkspace(wsId, 'def-2', '@s:localhost', 'sub', main.instanceId);
    updateAssignmentRole(sub.instanceId, 'standalone');
    const updated = listAssignments(wsId).find((a) => a.instanceId === sub.instanceId);
    expect(updated?.role).toBe('standalone');
    expect(updated?.parentInstanceId).toBeNull();
  });
});

describe('updateAssignmentApiKey — override 标志 + keychain', () => {
  beforeEach(() => {
    saveAgentDefinition(makeDef('def-1'));
  });

  it('非空 apiKey 写 keychain + 置 has_api_key_override=1', async () => {
    const a = assignAgentToWorkspace(wsId, 'def-1', '@a:localhost', 'standalone');
    await updateAssignmentApiKey(a.instanceId, 'sk-xxx');
    expect(memStore.get(`agent.${a.instanceId}.api_key_override`)).toBe('sk-xxx');
    const updated = listAssignments(wsId).find((x) => x.instanceId === a.instanceId);
    expect(updated?.hasApiKeyOverride).toBe(true);
  });

  it('apiKey=null 清除 override（keychain + DB 标志）', async () => {
    const a = assignAgentToWorkspace(wsId, 'def-1', '@a:localhost', 'standalone');
    await updateAssignmentApiKey(a.instanceId, 'sk-xxx');
    await updateAssignmentApiKey(a.instanceId, null);
    expect(memStore.has(`agent.${a.instanceId}.api_key_override`)).toBe(false);
    const updated = listAssignments(wsId).find((x) => x.instanceId === a.instanceId);
    expect(updated?.hasApiKeyOverride).toBe(false);
  });
});

describe('listSubAssignments', () => {
  beforeEach(() => {
    saveAgentDefinition(makeDef('def-1'));
    saveAgentDefinition(makeDef('def-2'));
    saveAgentDefinition(makeDef('def-3'));
  });

  it('返回同 ws + parent=指定的 subs', () => {
    const main = assignAgentToWorkspace(wsId, 'def-1', '@m:localhost', 'main');
    const sub1 = assignAgentToWorkspace(wsId, 'def-2', '@s1:localhost', 'sub', main.instanceId);
    const sub2 = assignAgentToWorkspace(wsId, 'def-3', '@s2:localhost', 'sub', main.instanceId);
    const subs = listSubAssignments(wsId, main.instanceId);
    expect(subs).toHaveLength(2);
    expect(subs.map((s) => s.instanceId).sort()).toEqual([sub1.instanceId, sub2.instanceId].sort());
  });

  it('main 没有 subs 时返回空数组', () => {
    const main = assignAgentToWorkspace(wsId, 'def-1', '@m:localhost', 'main');
    const subs = listSubAssignments(wsId, main.instanceId);
    expect(subs).toHaveLength(0);
  });
});

describe('deleteDefinition — 级联清理', () => {
  it('builtin 不可删', async () => {
    saveAgentDefinition({ ...makeDef('b-1'), source: 'builtin' });
    await expect(deleteDefinition('b-1')).rejects.toThrow(/builtin/);
  });

  it('custom def 级联清理 assignment + def 行', async () => {
    saveAgentDefinition(makeDef('c-1'));
    assignAgentToWorkspace(wsId, 'c-1', '@b1:localhost', 'standalone');
    assignAgentToWorkspace(wsId, 'c-1', '@b2:localhost', 'standalone');
    expect(listAssignments(wsId)).toHaveLength(2);

    await deleteDefinition('c-1');

    // def 行删除
    const { getAgentDefinition } = await import('../../src/main/agent/crud');
    expect(getAgentDefinition('c-1')).toBeNull();
    // assignment 也清理
    expect(listAssignments(wsId)).toHaveLength(0);
  });

  it('清 has_api_key_override 的 assignment 时同时清 keychain', async () => {
    saveAgentDefinition(makeDef('c-1'));
    const a = assignAgentToWorkspace(wsId, 'c-1', '@b:localhost', 'standalone');
    await updateAssignmentApiKey(a.instanceId, 'sk-xxx');
    expect(memStore.has(`agent.${a.instanceId}.api_key_override`)).toBe(true);

    await deleteDefinition('c-1');
    expect(memStore.has(`agent.${a.instanceId}.api_key_override`)).toBe(false);
  });
});

/**
 * Task 1（v2 agent 在线语义修复）：rowToAssignment 必须把 DB 列 last_running
 * 映射到 AgentAssignment.lastRunning（boolean）。DB 列已存在（v1.5.8 引入），
 * 本 task 仅补 TS 类型 + row 映射。
 *
 * 用 helper 建好 ws/def/assignment 骨架，再 UPDATE last_running 决定测试值；
 * 比直接写 raw SQL INSERT 干净，且 schema 演进时只需改 helper，不需动测试。
 */
describe('AgentAssignment.lastRunning 字段映射 (Task 1)', () => {
  function makeIsolatedWs(prefix: string): string {
    const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    getDb()
      .prepare(
        `INSERT INTO workspaces (id, name, owner_id, directory_path, team_session_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, 'test', '@owner:localhost', '/tmp', '!space:localhost');
    return id;
  }

  it('row.last_running=1 → assignment.lastRunning=true', () => {
    const localWsId = makeIsolatedWs('ws-test-last-running');
    saveAgentDefinition(makeDef('def-lr-1'));
    assignAgentToWorkspace(localWsId, 'def-lr-1', '@bot1:localhost', 'standalone');

    getDb()
      .prepare('UPDATE agent_assignments SET last_running = 1 WHERE workspace_id = ?')
      .run(localWsId);

    const list = listAssignments(localWsId);
    expect(list).toHaveLength(1);
    expect(list[0].lastRunning).toBe(true);
  });

  it('row.last_running=0 → assignment.lastRunning=false', () => {
    const localWsId = makeIsolatedWs('ws-test-last-running-off');
    saveAgentDefinition(makeDef('def-lr-2'));
    assignAgentToWorkspace(localWsId, 'def-lr-2', '@bot2:localhost', 'standalone');

    getDb()
      .prepare('UPDATE agent_assignments SET last_running = 0 WHERE workspace_id = ?')
      .run(localWsId);

    const list = listAssignments(localWsId);
    expect(list).toHaveLength(1);
    expect(list[0].lastRunning).toBe(false);
  });
});
