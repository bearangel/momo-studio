// electron/tests/agent/definition-impact.test.ts
//
// 2026-10-10 披露式级联：getDefinitionImpact（影响面预查）+ deleteDefinition /
// disablePreset（事务化级联内核）的行为锁。
//   - impact：零引用全 0 / 多空间成员 / leader 团队 / 全员失效会话（部分失效不计）/ 默认 agent
//   - 级联：单事务清 default + 成员 + def；FK 级联清 session_members / teams
//   - 守卫：deleteDefinition 拒 builtin；disablePreset 拒非 builtin
// Mock 方式同 crud-custom-def.test.ts：tmp 库 + 内存 keychain + runtime 两个假模块。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { getDb, runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import {
  getDefinitionImpact,
  deleteDefinition,
  disablePreset,
  getAgentDefinition,
} from '../../src/main/agent/crud';

vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  stopAgentRuntime: vi.fn(),
}));

const tmpRoot = path.join(os.tmpdir(), `ap-def-impact-${Date.now()}`);
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

function seedWorkspace(id: string, name: string): void {
  getDb()
    .prepare(
      `INSERT INTO workspaces
         (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES (?, ?, '', '/tmp', 0, '@owner:s', '📁')`,
    )
    .run(id, name);
}

function seedDef(id: string, slug: string, source: 'builtin' | 'custom'): void {
  getDb()
    .prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, system_prompt, model_name, source)
       VALUES (?, ?, ?, '1.0.0', 'p', 'm', ?)`,
    )
    .run(id, id.toUpperCase(), slug, source);
}

function seedMember(instanceId: string, workspaceId: string, defId: string): void {
  getDb()
    .prepare(
      `INSERT INTO workspace_agent_members
         (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES (?, ?, ?, ?)`,
    )
    .run(instanceId, workspaceId, defId, `@${instanceId}:s`);
}

function seedSession(id: string, workspaceId: string): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, workspace_id, title, created_at, updated_at)
       VALUES (?, ?, 's', 0, 0)`,
    )
    .run(id, workspaceId);
}

function seedSessionMember(sessionId: string, instanceId: string): void {
  getDb()
    .prepare(
      `INSERT INTO session_members (session_id, instance_id, is_leader, added_at)
       VALUES (?, ?, 0, 0)`,
    )
    .run(sessionId, instanceId);
}

function seedTeam(id: string, name: string, workspaceId: string, leaderInstanceId: string, memberIds: string[]): void {
  getDb()
    .prepare(
      `INSERT INTO teams (id, workspace_id, name, leader_instance_id)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, workspaceId, name, leaderInstanceId);
  const stmt = getDb().prepare(
    'INSERT INTO team_members (team_id, instance_id, added_at) VALUES (?, ?, 0)',
  );
  for (const m of memberIds) stmt.run(id, m);
}

describe('getDefinitionImpact — 影响面预查', () => {
  it('零引用：全部字段为空/0（未加入任何工作空间的 def）', () => {
    seedDef('def-x', 'x', 'custom');
    const impact = getDefinitionImpact('def-x');
    expect(impact).toEqual({
      memberCount: 0,
      workspaceNames: [],
      ledTeamNames: [],
      readOnlySessionCount: 0,
      defaultForWorkspaceNames: [],
    });
  });

  it('多空间成员 + leader 团队 + 全员失效会话 + 默认 agent：各维度齐全', () => {
    seedWorkspace('ws-a', '空间A');
    seedWorkspace('ws-b', '空间B');
    seedDef('def-x', 'x', 'custom');
    seedDef('def-other', 'other', 'custom');
    seedMember('inst-1', 'ws-a', 'def-x');
    seedMember('inst-2', 'ws-b', 'def-x');
    seedMember('inst-other', 'ws-a', 'def-other');
    // inst-1 是团队 leader（成员含另一 def 的成员——团队将整体解散）
    seedTeam('team-1', '冲锋队', 'ws-a', 'inst-1', ['inst-1', 'inst-other']);
    // 会话1：成员 = {inst-1, inst-2} 全在待删集 → 只读
    seedSession('sess-1', 'ws-a');
    seedSessionMember('sess-1', 'inst-1');
    seedSessionMember('sess-1', 'inst-2');
    // 会话2：成员 = {inst-1, inst-other} 尚有存活成员 → 不计
    seedSession('sess-2', 'ws-a');
    seedSessionMember('sess-2', 'inst-1');
    seedSessionMember('sess-2', 'inst-other');
    // 空间B 默认 agent 指向 inst-2
    getDb()
      .prepare('UPDATE workspaces SET default_agent_instance_id = ? WHERE id = ?')
      .run('inst-2', 'ws-b');

    const impact = getDefinitionImpact('def-x');
    expect(impact.memberCount).toBe(2);
    expect(impact.workspaceNames).toEqual(['空间A', '空间B']);
    expect(impact.ledTeamNames).toEqual(['冲锋队']);
    expect(impact.readOnlySessionCount).toBe(1);
    expect(impact.defaultForWorkspaceNames).toEqual(['空间B']);
  });

  it('def 不存在：throw（预查入口与删除同校验）', () => {
    expect(() => getDefinitionImpact('nope')).toThrow('未找到 agent 定义');
  });
});

describe('deleteDefinition / disablePreset — 事务化级联', () => {
  it('deleteDefinition（custom）：default 置空 + 成员/def 删除 + FK 级联清会话成员与团队', async () => {
    seedWorkspace('ws-a', '空间A');
    seedDef('def-x', 'x', 'custom');
    seedDef('def-other', 'other', 'custom');
    seedMember('inst-1', 'ws-a', 'def-x');
    seedMember('inst-other', 'ws-a', 'def-other');
    seedTeam('team-1', '冲锋队', 'ws-a', 'inst-1', ['inst-1', 'inst-other']);
    seedSession('sess-1', 'ws-a');
    seedSessionMember('sess-1', 'inst-1');
    getDb()
      .prepare('UPDATE workspaces SET default_agent_instance_id = ? WHERE id = ?')
      .run('inst-1', 'ws-a');

    const result = await deleteDefinition('def-x');
    expect(result.stoppedInstanceIds).toEqual([]);
    const db = getDb();
    expect(getAgentDefinition('def-x')).toBeNull();
    expect(db.prepare('SELECT * FROM workspace_agent_members WHERE agent_definition_id = ?').get('def-x')).toBeUndefined();
    // default 已置空（FK 不中止的铁证）
    expect(
      (db.prepare('SELECT default_agent_instance_id AS d FROM workspaces WHERE id = ?').get('ws-a') as { d: string | null }).d,
    ).toBeNull();
    // leader 团队随 FK 级联解散；另一成员不受影响
    expect(db.prepare('SELECT * FROM teams WHERE id = ?').get('team-1')).toBeUndefined();
    expect(
      db.prepare('SELECT * FROM workspace_agent_members WHERE instance_id = ?').get('inst-other'),
    ).toBeTruthy();
    // 会话成员快照级联清理（会话行本身保留——只读降级）
    expect(
      db.prepare('SELECT * FROM session_members WHERE instance_id = ?').get('inst-1'),
    ).toBeUndefined();
    expect(db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-1')).toBeTruthy();
  });

  it('deleteDefinition 拒 builtin（停用走 disablePreset 的分路口径）', async () => {
    seedDef('builtin-x', 'x', 'builtin');
    await expect(deleteDefinition('builtin-x')).rejects.toThrow('builtin agent 不可删除');
    expect(getAgentDefinition('builtin-x')).toBeTruthy();
  });

  it('disablePreset（builtin）：同内核级联——回到未启用态', async () => {
    seedWorkspace('ws-a', '空间A');
    seedDef('builtin-x', 'x', 'builtin');
    seedMember('inst-1', 'ws-a', 'builtin-x');
    seedSession('sess-1', 'ws-a');
    seedSessionMember('sess-1', 'inst-1');

    await disablePreset('builtin-x');
    const db = getDb();
    expect(getAgentDefinition('builtin-x')).toBeNull();
    expect(db.prepare('SELECT * FROM workspace_agent_members').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM session_members').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM sessions').all()).toHaveLength(1);
  });

  it('disablePreset 拒非 builtin 定义', async () => {
    seedDef('def-x', 'x', 'custom');
    await expect(disablePreset('def-x')).rejects.toThrow('非 builtin 定义不支持停用');
    expect(getAgentDefinition('def-x')).toBeTruthy();
  });

  it('keychain override 清理：事务成功后执行（成员带 override 的删除路径）', async () => {
    seedWorkspace('ws-a', '空间A');
    seedDef('def-x', 'x', 'custom');
    seedMember('inst-1', 'ws-a', 'def-x');
    getDb()
      .prepare('UPDATE workspace_agent_members SET api_key_override = 1 WHERE instance_id = ?')
      .run('inst-1');
    await memKeychain.setSecret('agent.inst-1.api_key_override', 'sk-test');

    await deleteDefinition('def-x');
    expect(await memKeychain.getSecret('agent.inst-1.api_key_override')).toBeNull();
  });
});
