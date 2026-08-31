// electron/tests/agent/team-crud.test.ts
//
// 团队服务 CRUD（v25 spec 2026-08-31 §4.2）：
//   - createTeam：建团事务原子性（成员 FK 不存在 → 整笔回滚零残留）/
//     leader 外集 throw / 成员 <2（去重后）throw / 重复 id 先去重
//   - setLeader：换 leader（事务保证 leader 在成员表，非成员 throw 且原值不变）
//   - removeTeamMember：leader 守卫 throw（参考 T3 removeMember 守卫风格）/ 普通成员移除 / 幂等
//   - deleteTeam：仅删定义（team_members 级联清空，workspace 成员不动）
//   - listTeams：JOIN 展开成员（WorkspaceAgentMember 全字段）+ leaderInstanceId 标记 + 跨 ws 隔离
//
// DB 隔离沿用仓库既定模式（参考 membership-crud.test.ts）：真实迁移链（v25）
// + foreign_keys ON（级联删除依赖）。成员夹具用 T3 真实 addMember 造（momo-test-rules：
// 业务逻辑用真实实现，不 mock DB）；团队夹具用裸 SQL 插入——被测方就是 team.ts，
// setLeader/deleteTeam 等用例不得依赖 createTeam 的正确性（RED 阶段互不牵连）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { addMember, listMembers } from '../../src/main/agent/crud';
import {
  createTeam,
  renameTeam,
  setLeader,
  addTeamMember,
  removeTeamMember,
  deleteTeam,
  listTeams,
} from '../../src/main/agent/team';

const tmpRoot = path.join(os.tmpdir(), `ap-team-crud-${Date.now()}`);

/** ws1 三成员 + ws2 一成员（T3 真实 addMember 产出；instanceId 为随机 UUID） */
let aliceId = '';
let bobId = '';
let carolId = '';
let daveId = '';

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();

  // 外键依赖链：workspaces → agent_definitions → workspace_agent_members（同 T3 夹具）
  const db = getDb();
  for (const [wsId, name] of [['ws1', 'WS一'], ['ws2', 'WS二'], ['ws3', 'WS三']] as const) {
    db.prepare(
      `INSERT INTO workspaces
         (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES (?, ?, '', '/tmp', 0, '@owner:s', '📁')`,
    ).run(wsId, name);
  }
  for (const [defId, slug] of [['def1', 'a'], ['def2', 'b'], ['def3', 'c']] as const) {
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, system_prompt, model_name)
       VALUES (?, ?, ?, '1', 'p', 'm')`,
    ).run(defId, defId.toUpperCase(), slug);
  }

  aliceId = (await addMember('ws1', 'def1', 'agent-alice-x')).instanceId;
  bobId = (await addMember('ws1', 'def2', 'agent-bob-x')).instanceId;
  carolId = (await addMember('ws1', 'def3', 'agent-carol-x')).instanceId;
  daveId = (await addMember('ws2', 'def1', 'agent-dave-x')).instanceId;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 裸 SQL 建团队（被测方是 team.ts 本身，夹具不得依赖 createTeam） */
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

function teamRowCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM teams').get() as { n: number }).n;
}

function teamMemberRowCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM team_members').get() as { n: number }).n;
}

function getTeamRow(
  teamId: string,
): { name: string; icon_emoji: string; leader_instance_id: string } | undefined {
  return getDb()
    .prepare('SELECT name, icon_emoji, leader_instance_id FROM teams WHERE id = ?')
    .get(teamId) as { name: string; icon_emoji: string; leader_instance_id: string } | undefined;
}

function memberIdsOf(teamId: string): string[] {
  return (
    getDb()
      .prepare('SELECT instance_id FROM team_members WHERE team_id = ? ORDER BY added_at, instance_id')
      .all(teamId) as { instance_id: string }[]
  ).map((r) => r.instance_id);
}

describe('createTeam — 建团事务与校验', () => {
  it('建团成功：返回 Team（真实 UUID / JOIN 展开成员 / leader 标记）且落库一致', () => {
    const team = createTeam('ws1', '前端小组', '🚀', [aliceId, bobId], aliceId);

    // teamId 是跨模块引用键（session 创建 / IPC）——必须真实唯一
    expect(team.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(team.workspaceId).toBe('ws1');
    expect(team.name).toBe('前端小组');
    expect(team.iconEmoji).toBe('🚀');
    expect(team.leaderInstanceId).toBe(aliceId);
    expect(team.createdAt).toBeTruthy();

    // members 是 JOIN 展开的 WorkspaceAgentMember（生产消费字段，非占位符）
    expect(team.members.map((m) => m.instanceId).sort()).toEqual([aliceId, bobId].sort());
    for (const m of team.members) {
      expect(m.workspaceId).toBe('ws1');
      expect(m.agentUserId).toMatch(/^agent-/);
      expect(m.createdAt).toBeTruthy();
    }
    const aliceMember = team.members.find((m) => m.instanceId === aliceId)!;
    expect(aliceMember.agentDefinitionId).toBe('def1');

    // 落库一致（返回值与 DB 行同源）
    const row = getTeamRow(team.id);
    expect(row).toBeTruthy();
    expect(row!.name).toBe('前端小组');
    expect(row!.leader_instance_id).toBe(aliceId);
    expect(memberIdsOf(team.id).sort()).toEqual([aliceId, bobId].sort());
  });

  it('成员 FK 不存在：整笔回滚——teams / team_members 零残留', () => {
    expect(() =>
      createTeam('ws1', '幽灵团', '👻', [aliceId, 'nonexistent-inst'], aliceId),
    ).toThrow(/不存在/);

    // 事务原子性：不允许留下半笔（teams 行先插、team_members FK 失败也必须整体回滚）
    expect(teamRowCount()).toBe(0);
    expect(teamMemberRowCount()).toBe(0);
  });

  it('leader 不在成员集内：throw 且零写入', () => {
    expect(() => createTeam('ws1', '外集团', '👑', [aliceId, bobId], carolId)).toThrow(/leader/);
    expect(teamRowCount()).toBe(0);
    expect(teamMemberRowCount()).toBe(0);
  });

  it('成员数 <2 throw：空数组 / 单成员 / 重复 id 去重后仅 1（先去重再校验）', () => {
    expect(() => createTeam('ws1', '空团', '👥', [], aliceId)).toThrow(/至少 2/);
    expect(() => createTeam('ws1', '独行团', '👤', [aliceId], aliceId)).toThrow(/至少 2/);
    // [a, a] 去重后仅 1 名成员——同 throw（且不给 PK 冲突先炸）
    expect(() => createTeam('ws1', '影分身团', '👥', [aliceId, aliceId], aliceId)).toThrow(/至少 2/);
    expect(teamRowCount()).toBe(0);
  });

  it('重复成员 id 先去重：[a, a, b] 建团成功且 team_members 恰 2 行', () => {
    const team = createTeam('ws1', '去重团', '🎯', [aliceId, aliceId, bobId], bobId);
    expect(team.members).toHaveLength(2);
    expect(memberIdsOf(team.id).sort()).toEqual([aliceId, bobId].sort());
  });
});

describe('renameTeam — 改名与图标', () => {
  it('改名：name 更新；带 iconEmoji 同步换图标；省略 iconEmoji 保留原值', () => {
    rawInsertTeam('team-r1', 'ws1', '旧名', aliceId, [aliceId, bobId]);

    renameTeam('team-r1', '新名');
    expect(getTeamRow('team-r1')).toMatchObject({ name: '新名', icon_emoji: '👥' });

    renameTeam('team-r1', '再改名', '🎉');
    expect(getTeamRow('team-r1')).toMatchObject({ name: '再改名', icon_emoji: '🎉' });

    // 改名不动成员与 leader
    expect(getTeamRow('team-r1')!.leader_instance_id).toBe(aliceId);
    expect(memberIdsOf('team-r1')).toHaveLength(2);
  });

  it('团队不存在：throw', () => {
    expect(() => renameTeam('nonexistent-team', 'x')).toThrow(/不存在/);
  });
});

describe('setLeader — 事务保证 leader 在成员表', () => {
  it('换成另一成员：leader 更新，成员集不变', () => {
    rawInsertTeam('team-s1', 'ws1', '甲组', bobId, [aliceId, bobId]);

    setLeader('team-s1', aliceId);

    expect(getTeamRow('team-s1')!.leader_instance_id).toBe(aliceId);
    expect(memberIdsOf('team-s1').sort()).toEqual([aliceId, bobId].sort());
  });

  it('新 leader 不在团队成员表：throw 且原 leader 不变', () => {
    rawInsertTeam('team-s2', 'ws1', '乙组', aliceId, [aliceId, bobId]);

    // carol 是同 ws 成员但不在团队内——必须拒绝（leader 必须在成员表）
    expect(() => setLeader('team-s2', carolId)).toThrow(/成员/);
    expect(getTeamRow('team-s2')!.leader_instance_id).toBe(aliceId);
    expect(memberIdsOf('team-s2')).toHaveLength(2);
  });

  it('团队不存在：throw', () => {
    expect(() => setLeader('nonexistent-team', aliceId)).toThrow(/不存在/);
  });
});

describe('addTeamMember — 加团队成员', () => {
  it('加成员：team_members 增一行，listTeams 反映', () => {
    rawInsertTeam('team-m1', 'ws1', '小组', aliceId, [aliceId, bobId]);

    addTeamMember('team-m1', carolId);

    expect(memberIdsOf('team-m1').sort()).toEqual([aliceId, bobId, carolId].sort());
    const teams = listTeams('ws1');
    expect(teams[0]!.members).toHaveLength(3);
  });

  it('重复添加同成员：throw', () => {
    rawInsertTeam('team-m2', 'ws1', '小组', aliceId, [aliceId, bobId]);
    expect(() => addTeamMember('team-m2', bobId)).toThrow(/已在/);
    expect(memberIdsOf('team-m2')).toHaveLength(2);
  });

  it('成员 instanceId 不存在（FK）：throw 且零写入', () => {
    rawInsertTeam('team-m3', 'ws1', '小组', aliceId, [aliceId, bobId]);
    expect(() => addTeamMember('team-m3', 'ghost-inst')).toThrow(/不存在/);
    expect(memberIdsOf('team-m3')).toHaveLength(2);
  });

  it('团队不存在：throw', () => {
    expect(() => addTeamMember('nonexistent-team', aliceId)).toThrow(/不存在/);
  });
});

describe('removeTeamMember — leader 守卫', () => {
  it('移除普通成员：该行删除，团队与其他成员保留', () => {
    rawInsertTeam('team-rm1', 'ws1', '小组', aliceId, [aliceId, bobId, carolId]);

    removeTeamMember('team-rm1', bobId);

    expect(memberIdsOf('team-rm1').sort()).toEqual([aliceId, carolId].sort());
    expect(getTeamRow('team-rm1')!.leader_instance_id).toBe(aliceId);
  });

  it('移除 leader：throw，团队零破坏', () => {
    rawInsertTeam('team-rm2', 'ws1', '小组', aliceId, [aliceId, bobId]);

    expect(() => removeTeamMember('team-rm2', aliceId)).toThrow(/leader/);

    // 被拒 = 零破坏：团队行、leader、成员集全部保留
    expect(getTeamRow('team-rm2')).toBeTruthy();
    expect(getTeamRow('team-rm2')!.leader_instance_id).toBe(aliceId);
    expect(memberIdsOf('team-rm2').sort()).toEqual([aliceId, bobId].sort());
  });

  it('不存在的成员 / 团队：幂等 no-op 不 throw', () => {
    rawInsertTeam('team-rm3', 'ws1', '小组', aliceId, [aliceId, bobId]);

    expect(() => removeTeamMember('team-rm3', 'nonexistent-inst')).not.toThrow();
    expect(() => removeTeamMember('nonexistent-team', aliceId)).not.toThrow();
    expect(memberIdsOf('team-rm3')).toHaveLength(2);
  });
});

describe('deleteTeam — 仅删定义', () => {
  it('删团队：teams / team_members 清空，workspace 成员全数保留', () => {
    rawInsertTeam('team-d1', 'ws1', '解散组', aliceId, [aliceId, bobId, carolId]);

    deleteTeam('team-d1');

    expect(getTeamRow('team-d1')).toBeUndefined();
    expect(memberIdsOf('team-d1')).toHaveLength(0);
    // 「不动成员」：workspace_agent_members 三人全在（会话快照按 session_members 存量，同样不触）
    expect(listMembers('ws1')).toHaveLength(3);
  });

  it('不存在的团队：幂等 no-op', () => {
    expect(() => deleteTeam('nonexistent-team')).not.toThrow();
  });
});

describe('listTeams — JOIN 展开', () => {
  it('展开成员（WorkspaceAgentMember 全字段）与 leader 标记；跨 ws 隔离', () => {
    rawInsertTeam('team-la', 'ws1', '甲组', bobId, [aliceId, bobId]);
    rawInsertTeam('team-lb', 'ws2', '乙组', daveId, [daveId]);

    const ws1Teams = listTeams('ws1');
    expect(ws1Teams).toHaveLength(1);

    const t = ws1Teams[0]!;
    expect(t.id).toBe('team-la');
    expect(t.name).toBe('甲组');
    // leader 标记：UI 依此渲染 👑
    expect(t.leaderInstanceId).toBe(bobId);

    // JOIN 展开：断言生产消费字段（instanceId / agentUserId / def 引用 / 在线态）
    expect(t.members.map((m) => m.instanceId).sort()).toEqual([aliceId, bobId].sort());
    const leaderMember = t.members.find((m) => m.instanceId === bobId)!;
    expect(leaderMember.agentUserId).toBe('agent-bob-x');
    expect(leaderMember.agentDefinitionId).toBe('def2');
    expect(leaderMember.workspaceId).toBe('ws1');
    expect(leaderMember.lastRunning).toBe(true);

    // 跨 ws 隔离：ws2 只见乙组
    const ws2Teams = listTeams('ws2');
    expect(ws2Teams).toHaveLength(1);
    expect(ws2Teams[0]!.id).toBe('team-lb');
    expect(ws2Teams[0]!.members.map((m) => m.instanceId)).toEqual([daveId]);
  });

  it('多团队全部展开；空 workspace 返回 []', () => {
    rawInsertTeam('team-lc', 'ws1', '甲组', aliceId, [aliceId, bobId]);
    rawInsertTeam('team-ld', 'ws1', '乙组', carolId, [carolId, bobId]);

    const teams = listTeams('ws1');
    expect(teams.map((t) => t.id).sort()).toEqual(['team-lc', 'team-ld'].sort());
    for (const t of teams) {
      expect(t.members).toHaveLength(2);
      // 不变量：leader 必在展开成员内
      expect(t.members.map((m) => m.instanceId)).toContain(t.leaderInstanceId);
    }

    expect(listTeams('ws3')).toEqual([]);
  });
});
