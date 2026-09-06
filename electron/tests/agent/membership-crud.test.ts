// electron/tests/agent/membership-crud.test.ts
//
// membership CRUD（v25 spec 2026-08-31 §4.1）：
//   - addMember：加成员 → listMembers 可见 / 重复添加 throw / apiKeyOverride 写 keychain + 标志
//   - removeMember：无团队删除 ok（幂等）/ leader 守卫 blockedTeams 含团队名 /
//     非 leader 删除 team_members 级联为空 / 删除命中 default → workspaces 置 NULL
//
// DB 隔离沿用仓库既定模式（参考 sessions-repo.test.ts / migration-v25.test.ts）：
//   - AP_USER_DATA_DIR 指向临时目录 + runMigrations() 真实迁移链（v25）
//   - closeDb() afterEach 复位单例；foreign_keys = ON（级联删除依赖此 PRAGMA）
//   - teams / team_members 夹具用裸 SQL 插入（team 服务 Task 4 才实现）
//
// keychain 是 OS 边界，经 setKeychainImpl 注入内存实现（momo-test-rules：只 mock
// 进程/网络边界）；DB 全程真实，断言生产消费字段（instanceId 唯一性 / 落库标志）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl } from '../../src/main/storage/keychain';
import { addMember, removeMember, listMembers } from '../../src/main/agent/crud';

const tmpRoot = path.join(os.tmpdir(), `ap-membership-crud-${Date.now()}`);

/** 内存 keychain（OS 边界替身）；断言 addMember 的 override 写入真实 key 名 */
const fakeKeychain = new Map<string, string>();

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  fakeKeychain.clear();
  setKeychainImpl({
    setSecret: async (key, value) => {
      fakeKeychain.set(key, value);
    },
    getSecret: async (key) => fakeKeychain.get(key) ?? null,
    deleteSecret: async (key) => {
      fakeKeychain.delete(key);
    },
  });

  // 外键依赖链：workspaces → agent_definitions → workspace_agent_members
  const db = getDb();
  for (const [wsId, name] of [['ws1', 'WS一'], ['ws2', 'WS二']] as const) {
    db.prepare(
      `INSERT INTO workspaces
         (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES (?, ?, '', '/tmp', 0, '@owner:s', '📁')`,
    ).run(wsId, name);
  }
  for (const [defId, slug] of [['def1', 'a'], ['def2', 'b']] as const) {
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, system_prompt, model_name)
       VALUES (?, ?, ?, '1', 'p', 'm')`,
    ).run(defId, defId.toUpperCase(), slug);
  }
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 裸 SQL 插成员行（removeMember 用例独立于 addMember 造夹具，RED 阶段互不牵连） */
function rawInsertMember(instanceId: string, workspaceId: string, defId: string): void {
  getDb()
    .prepare(
      `INSERT INTO workspace_agent_members
         (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES (?, ?, ?, ?)`,
    )
    .run(instanceId, workspaceId, defId, `@${instanceId}:s`);
}

/** 裸 SQL 建团队（team 服务 Task 4 才实现；leader + 成员集一次插入） */
function rawInsertTeam(
  teamId: string,
  workspaceId: string,
  name: string,
  leaderInstanceId: string,
  memberInstanceIds: string[],
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO teams (id, workspace_id, name, leader_instance_id)
     VALUES (?, ?, ?, ?)`,
  ).run(teamId, workspaceId, name, leaderInstanceId);
  const addMemberStmt = db.prepare(
    'INSERT INTO team_members (team_id, instance_id, added_at) VALUES (?, ?, ?)',
  );
  for (const [i, inst] of memberInstanceIds.entries()) {
    addMemberStmt.run(teamId, inst, i + 1);
  }
}

describe('addMember — 加入 workspace', () => {
  it('v2.2 回归锁：addMember 返回值即带 agentName（JOIN definitions；新成员进 store 不显示 ID）', async () => {
    const member = await addMember('ws1', 'def1', 'agent-a-x9');
    expect(member.agentName).toBe('DEF1');
    expect(member.iconEmoji).toBe('🤖'); // icon_emoji 列 DEFAULT '🤖'（migration v1）
  });

  it('v2.2 回归锁：listMembers 对裸插入行同样 JOIN 出 agentName/iconEmoji', () => {
    rawInsertMember('inst-join-1', 'ws1', 'def1');
    const m = listMembers('ws1').find((x) => x.instanceId === 'inst-join-1')!;
    expect(m.agentName).toBe('DEF1');
    expect(m.iconEmoji).toBe('🤖');
  });

  it('加成员后 listMembers 可见；跨 workspace 隔离；断言生产消费字段', async () => {
    const member = await addMember('ws1', 'def1', 'agent-a-x1');

    // instanceId 是跨模块主键（session_members/team_members/default 引用它）——必须真实唯一
    expect(member.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(member.workspaceId).toBe('ws1');
    expect(member.agentDefinitionId).toBe('def1');
    expect(member.agentUserId).toBe('agent-a-x1');
    // v25 列默认：api_key_override=0 / last_running=1 / created_at datetime('now')
    expect(member.hasApiKeyOverride).toBe(false);
    expect(member.lastRunning).toBe(true);
    expect(member.createdAt).toBeTruthy();

    const ws1Members = listMembers('ws1');
    expect(ws1Members).toHaveLength(1);
    expect(ws1Members[0]?.instanceId).toBe(member.instanceId);
    // workspace 隔离：ws2 看不到
    expect(listMembers('ws2')).toHaveLength(0);

    // 落库行与返回值一致（消费方 listMembers 读的是同一行）
    const row = getDb()
      .prepare('SELECT * FROM workspace_agent_members WHERE instance_id = ?')
      .get(member.instanceId) as { agent_user_id: string };
    expect(row.agent_user_id).toBe('agent-a-x1');
  });

  it('重复添加（同 ws 同 def）throw；同 def 加入另一 ws 不受影响', async () => {
    await addMember('ws1', 'def1', 'agent-a-x1');
    await expect(addMember('ws1', 'def1', 'agent-a-x2')).rejects.toThrow(/已加入/);

    // 唯一性是 per-ws 的：def1 加入 ws2 合法
    const other = await addMember('ws2', 'def1', 'agent-a-x3');
    expect(other.workspaceId).toBe('ws2');
    expect(listMembers('ws2')).toHaveLength(1);
  });

  it('apiKeyOverride：写 keychain agent.<instanceId>.api_key_override + DB 标志=1', async () => {
    const member = await addMember('ws1', 'def1', 'agent-a-x1', 'sk-override-1');

    expect(member.hasApiKeyOverride).toBe(true);
    // resolveApiKey 消费该 keychain 槽位——锁真实 key 名与值
    expect(fakeKeychain.get(`agent.${member.instanceId}.api_key_override`)).toBe('sk-override-1');
    const row = getDb()
      .prepare('SELECT api_key_override FROM workspace_agent_members WHERE instance_id = ?')
      .get(member.instanceId) as { api_key_override: number };
    expect(row.api_key_override).toBe(1);

    // 不传 override 的成员标志为 0
    const plain = await addMember('ws1', 'def2', 'agent-b-x1');
    expect(plain.hasApiKeyOverride).toBe(false);
    expect(fakeKeychain.has(`agent.${plain.instanceId}.api_key_override`)).toBe(false);
  });
});

describe('removeMember — leader 守卫 + 级联', () => {
  it('无团队时删除 ok：行删除、listMembers 为空、不存在 id 幂等 ok', () => {
    rawInsertMember('inst1', 'ws1', 'def1');
    expect(removeMember('inst1')).toEqual({ ok: true });

    expect(listMembers('ws1')).toHaveLength(0);
    const row = getDb()
      .prepare('SELECT * FROM workspace_agent_members WHERE instance_id = ?')
      .get('inst1');
    expect(row).toBeUndefined();

    // 不存在的 instanceId：幂等 no-op，仍返回 ok（沿用旧 handler 语义）
    expect(removeMember('nonexistent-inst')).toEqual({ ok: true });
  });

  it('为 leader 时删除被拒：返回 blockedTeams 含团队名，成员行与团队都保留', () => {
    rawInsertMember('leader-1', 'ws1', 'def1');
    rawInsertMember('member-1', 'ws1', 'def2');
    rawInsertTeam('team-1', 'ws1', '前端小组', 'leader-1', ['leader-1', 'member-1']);

    const result = removeMember('leader-1');
    expect(result).toEqual({ ok: false, blockedTeams: ['前端小组'] });

    // 被拒 = 零破坏：成员行还在、团队与团队成員都还在
    const memberRow = getDb()
      .prepare('SELECT * FROM workspace_agent_members WHERE instance_id = ?')
      .get('leader-1');
    expect(memberRow).toBeTruthy();
    const teamRow = getDb().prepare('SELECT * FROM teams WHERE id = ?').get('team-1');
    expect(teamRow).toBeTruthy();
    expect(listMembers('ws1')).toHaveLength(2);
  });

  it('同时是多个团队的 leader：blockedTeams 收齐全部团队名', () => {
    rawInsertMember('leader-2', 'ws1', 'def1');
    rawInsertMember('member-2', 'ws1', 'def2');
    rawInsertTeam('team-a', 'ws1', '前端小组', 'leader-2', ['leader-2', 'member-2']);
    rawInsertTeam('team-b', 'ws1', '后端小组', 'leader-2', ['leader-2']);

    const result = removeMember('leader-2');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 收齐全部团队名（顺序无契约保证，集合比较）
      expect(new Set(result.blockedTeams)).toEqual(new Set(['前端小组', '后端小组']));
    }
  });

  it('非 leader 删除 ok：team_members 级联清空该成员，团队与其他成员保留', () => {
    rawInsertMember('leader-3', 'ws1', 'def1');
    rawInsertMember('member-3', 'ws1', 'def2');
    rawInsertTeam('team-3', 'ws1', '协作组', 'leader-3', ['leader-3', 'member-3']);

    expect(removeMember('member-3')).toEqual({ ok: true });

    // 该成员的 team_members 行被 FK CASCADE 清掉；leader 的行保留
    const rows = getDb()
      .prepare('SELECT instance_id FROM team_members WHERE team_id = ?')
      .all('team-3') as { instance_id: string }[];
    expect(rows.map((r) => r.instance_id)).toEqual(['leader-3']);
    // 团队本身不受影响（只删成员，不删团队）
    expect(getDb().prepare('SELECT * FROM teams WHERE id = ?').get('team-3')).toBeTruthy();
    expect(listMembers('ws1')).toHaveLength(1);
  });

  it('删除命中 default agent：事务内置空 workspaces.default_agent_instance_id', () => {
    rawInsertMember('default-1', 'ws1', 'def1');
    getDb()
      .prepare('UPDATE workspaces SET default_agent_instance_id = ? WHERE id = ?')
      .run('default-1', 'ws1');

    // default_agent_instance_id FK 无 ON DELETE 动作——不先置空则 DELETE 直接 FK 中止抛错；
    // 返回 ok 即证明事务内先置空后删除的实现存在
    expect(removeMember('default-1')).toEqual({ ok: true });

    const ws = getDb()
      .prepare('SELECT default_agent_instance_id FROM workspaces WHERE id = ?')
      .get('ws1') as { default_agent_instance_id: string | null };
    expect(ws.default_agent_instance_id).toBeNull();
  });

  it('删除普通成员不触碰其他 workspace 的 default agent 引用', () => {
    rawInsertMember('keep-1', 'ws1', 'def1');
    rawInsertMember('victim-1', 'ws2', 'def2');
    getDb()
      .prepare('UPDATE workspaces SET default_agent_instance_id = ? WHERE id = ?')
      .run('keep-1', 'ws1');

    expect(removeMember('victim-1')).toEqual({ ok: true });

    const ws1 = getDb()
      .prepare('SELECT default_agent_instance_id FROM workspaces WHERE id = ?')
      .get('ws1') as { default_agent_instance_id: string | null };
    expect(ws1.default_agent_instance_id).toBe('keep-1');
  });
});
