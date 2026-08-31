// electron/tests/im/session-ops.test.ts
//
// session-ops（v2.0.0 P1 会话生命周期）纯 SQLite 操作测试。
// v25 Task 6 复核重写（spec 2026-08-31 §3.3/§4.4）：
//   - createSession 带 memberInstanceIds（session_members.instance_id）
//   - deleteSessionOp 级联清理（团队会话保护概念已退役，不再有禁删用例）
//   - getSessionsForWorkspace 过滤 + titleAuto 映射
//   - getSessionMembersInfo 三表 JOIN + is_leader 建会快照锁——
//     含「快照独立性」断言：workspace 默认 agent 指向非 leader 成员时
//     isLeader 仍按快照列，杜绝实现回退到「比 default_agent_instance_id」
// v25 Task 7 双流程（spec §4.4）：
//   - createQuickSession：默认 agent 直达（无默认 throw NoDefaultAgentError）
//   - createCollabSession：单 agent / 团队快照展开 + leader 标记 + title_auto 语义
//   - 团队后续变更不影响已建会话（快照铁律，spec §7 错误处理表「团队编辑」行）
//
// DB 隔离沿用 sessions-repo.test.ts 模式：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - runMigrations() 跑到 v25（workspace_agent_members/session_members.is_leader 存在）
//   - closeDb() 在 afterEach 复位单例；foreign_keys = ON
//   - FK 依赖链：workspaces → agent_definitions → workspace_agent_members
//   - is_leader 经生产 repo.addSessionMember 写入（不绕过生产路径裸拼快照位）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import {
  createSession,
  createQuickSession,
  createCollabSession,
  NoDefaultAgentError,
  renameSession,
  deleteSessionOp,
  getSessionsForWorkspace,
  getSessionMembersInfo,
} from '../../src/main/im/session-ops';
import { createTeam, setLeader, addTeamMember, listTeams } from '../../src/main/agent/team';

const tmpRoot = path.join(os.tmpdir(), `ap-session-ops-${Date.now()}`);

/** 用最小列写入 workspaces 行；defaultAgentInstanceId 缺省 null。仅本测试用。 */
function seedWorkspace(
  db: ReturnType<typeof getDb>,
  id: string,
  defaultAgentInstanceId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji,
        default_agent_instance_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'WS', '', '/tmp', 0, '@owner:s', '📁', defaultAgentInstanceId);
}

/** 写入一条 agent_definitions 行。仅本测试用。 */
function seedAgentDef(
  db: ReturnType<typeof getDb>,
  id: string,
  name: string,
  iconEmoji: string,
): void {
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, system_prompt, model_name, icon_emoji)
     VALUES (?, ?, ?, '1', 'p', 'm', ?)`,
  ).run(id, name, name.toLowerCase(), iconEmoji);
}

/** 写入一条 workspace_agent_members 行（v25 成员制：无 role/parent/enabled）。 */
function seedMember(
  db: ReturnType<typeof getDb>,
  instanceId: string,
  workspaceId: string,
  defId: string,
  agentUserId: string,
  lastRunning: 0 | 1,
): void {
  db.prepare(
    `INSERT INTO workspace_agent_members
       (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(instanceId, workspaceId, defId, agentUserId, lastRunning);
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('session-ops', () => {
  it('createSession 写入 sessions 行 + 全部 memberInstanceIds 入会话（titleAuto 默认 false）', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'A', '🤖');
    seedAgentDef(db, 'def2', 'B', '🤖');
    // v25 约束：同 ws 同 def 唯一（idx_wam_unique）→ 两成员各用不同 def
    seedMember(db, 'inst1', 'ws1', 'def1', '@bot:s', 1);
    seedMember(db, 'inst2', 'ws1', 'def2', '@bot2:s', 1);

    const row = createSession({
      workspaceId: 'ws1',
      title: '团队讨论',
      memberInstanceIds: ['inst1', 'inst2'],
    });

    expect(row.workspaceId).toBe('ws1');
    expect(row.title).toBe('团队讨论');
    expect(row.kind).toBe('chat');
    expect(row.titleAuto).toBe(false);

    // session_members 已落库（v25 列名 instance_id）
    const memberRows = db
      .prepare('SELECT instance_id FROM session_members WHERE session_id = ? ORDER BY added_at ASC')
      .all(row.id) as Array<{ instance_id: string }>;
    expect(memberRows.map((m) => m.instance_id)).toEqual(['inst1', 'inst2']);
  });

  it('createSession 不指定 memberInstanceIds 视为空成员（不下异常）', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    const row = createSession({ workspaceId: 'ws1', title: '空会话' });
    const memberRows = db
      .prepare('SELECT instance_id FROM session_members WHERE session_id = ?')
      .all(row.id) as Array<{ instance_id: string }>;
    expect(memberRows).toEqual([]);
  });

  it('createSession 支持显式 kind=task_execution', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    const row = createSession({
      workspaceId: 'ws1',
      title: '执行任务',
      memberInstanceIds: [],
      kind: 'task_execution',
    });
    expect(row.kind).toBe('task_execution');
  });

  it('renameSession 改 title', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    const row = insertSession({ workspaceId: 'ws1', title: '旧' });
    renameSession(row.id, '新');
    const after = db.prepare('SELECT title FROM sessions WHERE id = ?').get(row.id) as { title: string };
    expect(after.title).toBe('新');
  });

  it('createSession 原子性：成员含不存在 instance_id → 抛错且 sessions 表无残留', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'A', '🤖');
    seedMember(db, 'inst1', 'ws1', 'def1', '@bot:s', 1);
    // 'inst-nope' 不存在 → session_members.instance_id FK 触发异常
    expect(() =>
      createSession({
        workspaceId: 'ws1',
        title: '将失败',
        memberInstanceIds: ['inst1', 'inst-nope'],
      }),
    ).toThrow();

    // 整笔回滚：sessions 表无残留
    const sessionRows = db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
    expect(sessionRows).toEqual([]);
    const memberRows = db.prepare('SELECT instance_id FROM session_members').all() as unknown[];
    expect(memberRows).toEqual([]);
  });

  it('deleteSessionOp 正常删除；cascade 清空 session_members', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'A', '🤖');
    seedMember(db, 'inst1', 'ws1', 'def1', '@bot:s', 1);
    const row = insertSession({ workspaceId: 'ws1', title: 'a' });
    addSessionMember(row.id, 'inst1');

    deleteSessionOp(row.id);
    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(row.id)).toBeUndefined();
    expect(
      (db.prepare('SELECT instance_id FROM session_members WHERE session_id = ?').all(row.id) as unknown[])
        .length,
    ).toBe(0);
  });

  it('getSessionsForWorkspace 按 workspace 过滤 + titleAuto 映射；无参返全部', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedWorkspace(db, 'ws-other');

    insertSession({ workspaceId: 'ws1', title: 'a' });
    const autoRow = insertSession({ workspaceId: 'ws1', title: 'b' });
    db.prepare('UPDATE sessions SET title_auto = 1 WHERE id = ?').run(autoRow.id);
    insertSession({ workspaceId: 'ws-other', title: 'c' });

    const list1 = getSessionsForWorkspace('ws1');
    expect(list1).toHaveLength(2);
    expect(list1.every((s) => s.workspaceId === 'ws1')).toBe(true);
    // title_auto 快照列 → summary.titleAuto 布尔映射
    const autoSummary = list1.find((s) => s.id === autoRow.id);
    expect(autoSummary?.titleAuto).toBe(true);
    expect(list1.find((s) => s.title === 'a')?.titleAuto).toBe(false);

    const list2 = getSessionsForWorkspace('ws-other');
    expect(list2).toHaveLength(1);
    expect(list2[0]?.title).toBe('c');

    // 不传参 → 全部 ws
    const listAll = getSessionsForWorkspace();
    expect(listAll.length).toBeGreaterThanOrEqual(3);

    // 未知 ws → 空数组
    expect(getSessionsForWorkspace('ws-nope')).toEqual([]);
  });

  it('getSessionMembersInfo 三表 JOIN：字段齐全、按 added_at 升序、isLeader 读建会快照', () => {
    const db = getDb();
    // 先建 workspace（default 为 NULL——default_agent_instance_id 有 FK，须成员存在后回填）
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'Alpha', '🦊');
    seedAgentDef(db, 'def2', 'Beta', '🐼');
    seedMember(db, 'inst-leader', 'ws1', 'def1', '@leader:s', 1);   // leader，在线
    seedMember(db, 'inst-member', 'ws1', 'def2', '@member:s', 0);   // 非 leader，已停止
    // 快照独立性伏笔：workspace 默认 agent 指向「非 leader」成员 inst-member
    db.prepare('UPDATE workspaces SET default_agent_instance_id = ? WHERE id = ?')
      .run('inst-member', 'ws1');

    const row = insertSession({ workspaceId: 'ws1', title: 'a' });
    // is_leader 经生产 repo 写入（1/0 两行各一）
    addSessionMember(row.id, 'inst-member', false);  // 先加 member
    addSessionMember(row.id, 'inst-leader', true);   // 后加 leader
    // 注：added_at 同毫秒可能相同 → 显式拉开时间戳（v25 列名 instance_id）
    const setAddedAt = db.prepare(
      'UPDATE session_members SET added_at = ? WHERE session_id = ? AND instance_id = ?',
    );
    setAddedAt.run(1000, row.id, 'inst-member');
    setAddedAt.run(2000, row.id, 'inst-leader');

    const info = getSessionMembersInfo(row.id);
    expect(info).toHaveLength(2);

    // added_at ASC：member 在前；契约五字段逐一断言
    expect(info[0]).toEqual({
      instanceId: 'inst-member',
      agentName: 'Beta',
      iconEmoji: '🐼',
      lastRunning: false,
      isLeader: false,
    });
    expect(info[1]).toEqual({
      instanceId: 'inst-leader',
      agentName: 'Alpha',
      iconEmoji: '🦊',
      lastRunning: true,
      isLeader: true,
    });

    // 快照独立性锁：默认 agent 指向 inst-member，但其 isLeader 仍按快照 = false；
    // 若实现回退到「比 default_agent_instance_id」，此处两断言同时翻红
    expect(info[0]?.isLeader).toBe(false);
    expect(info[1]?.isLeader).toBe(true);
  });

  it('getSessionMembersInfo 无成员返回空数组（不抛错）', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    const row = insertSession({ workspaceId: 'ws1', title: 'empty' });
    expect(getSessionMembersInfo(row.id)).toEqual([]);
  });
});

describe('createQuickSession（spec §4.4）', () => {
  it('有默认 agent：单成员 is_leader=1、title=新会话、title_auto=1', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1'); // default_agent_instance_id 有 FK，须先有成员再回填
    seedAgentDef(db, 'def1', 'Alpha', '🦊');
    seedMember(db, 'inst-default', 'ws1', 'def1', '@default:s', 1);
    db.prepare('UPDATE workspaces SET default_agent_instance_id = ? WHERE id = ?')
      .run('inst-default', 'ws1');

    const row = createQuickSession('ws1');

    expect(row.workspaceId).toBe('ws1');
    expect(row.title).toBe('新会话');
    expect(row.titleAuto).toBe(true);
    expect(row.kind).toBe('chat');

    // 生产读路径断言：唯一成员即默认 agent，且 is_leader 快照 = 1
    const members = getSessionMembersInfo(row.id);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ instanceId: 'inst-default', isLeader: true });
  });

  it('无默认 agent：throw NoDefaultAgentError（code + message 双契约），零建会副作用', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1'); // default 缺省 null

    let caught: unknown;
    try {
      createQuickSession('ws1');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(NoDefaultAgentError);
    expect((caught as NoDefaultAgentError).code).toBe('NO_DEFAULT_AGENT');
    // IPC 序列化只保留 message——renderer 靠 message 子串识别（types.d.ts 契约）
    expect((caught as Error).message).toContain('NO_DEFAULT_AGENT');

    expect(db.prepare('SELECT id FROM sessions').all()).toEqual([]);
  });

  it('workspace 不存在：抛明确错误，零建会副作用', () => {
    const db = getDb();
    expect(() => createQuickSession('ws-nope')).toThrow('未找到 workspace');
    expect(db.prepare('SELECT id FROM sessions').all()).toEqual([]);
  });
});

describe('createCollabSession（spec §4.4）', () => {
  function seedSoloWs(): void {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'Alpha', '🦊');
    seedMember(db, 'inst7', 'ws1', 'def1', '@alpha:s', 1);
  }

  it('单 agent 目标：单成员 is_leader=1；实名 title → title_auto=0', () => {
    seedSoloWs();

    const row = createCollabSession('ws1', '规划评审', { type: 'agent', instanceId: 'inst7' });

    expect(row.title).toBe('规划评审');
    expect(row.titleAuto).toBe(false);
    expect(row.kind).toBe('chat');
    const members = getSessionMembersInfo(row.id);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ instanceId: 'inst7', isLeader: true });
  });

  it('title 空/空白视为留空：占位标题 + title_auto=1（与实名差异锁）', () => {
    seedSoloWs();

    for (const emptyTitle of [null, '', '   ']) {
      const row = createCollabSession('ws1', emptyTitle, { type: 'agent', instanceId: 'inst7' });
      expect(row.title).toBe('新会话');
      expect(row.titleAuto).toBe(true);
    }
  });

  it('团队目标：快照展开全部成员，leader 成员 is_leader=1、其余 0', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'Leader', '👑');
    seedAgentDef(db, 'def2', 'Beta', '🐼');
    seedAgentDef(db, 'def3', 'Gamma', '🦊');
    seedMember(db, 'inst-leader', 'ws1', 'def1', '@leader:s', 1);
    seedMember(db, 'inst-a', 'ws1', 'def2', '@beta:s', 1);
    seedMember(db, 'inst-b', 'ws1', 'def3', '@gamma:s', 0); // 建会后才入队（快照外）
    const team = createTeam('ws1', '攻坚组', '👥', ['inst-leader', 'inst-a'], 'inst-leader');

    const row = createCollabSession('ws1', null, { type: 'team', teamId: team.id });

    expect(row.title).toBe('新会话');
    expect(row.titleAuto).toBe(true);
    const members = getSessionMembersInfo(row.id);
    expect(members.map((m) => m.instanceId).sort()).toEqual(['inst-a', 'inst-leader']);
    expect(members.find((m) => m.instanceId === 'inst-leader')?.isLeader).toBe(true);
    expect(members.find((m) => m.instanceId === 'inst-a')?.isLeader).toBe(false);
  });

  it('快照铁律：建会后团队换 leader / 加成员，已建会话 members 不变', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'Leader', '👑');
    seedAgentDef(db, 'def2', 'Beta', '🐼');
    seedAgentDef(db, 'def3', 'Gamma', '🦊');
    seedMember(db, 'inst-leader', 'ws1', 'def1', '@leader:s', 1);
    seedMember(db, 'inst-a', 'ws1', 'def2', '@beta:s', 1);
    seedMember(db, 'inst-b', 'ws1', 'def3', '@gamma:s', 0);
    const team = createTeam('ws1', '攻坚组', '👥', ['inst-leader', 'inst-a'], 'inst-leader');

    const row = createCollabSession('ws1', '协作', { type: 'team', teamId: team.id });

    // 生产团队服务改团队（不是裸 UPDATE team_members）
    setLeader(team.id, 'inst-a');
    addTeamMember(team.id, 'inst-b');

    // 前提锁：团队确实变了
    const teamAfter = listTeams('ws1').find((t) => t.id === team.id);
    expect(teamAfter?.leaderInstanceId).toBe('inst-a');
    expect(teamAfter?.members.map((m) => m.instanceId).sort()).toEqual(['inst-a', 'inst-b', 'inst-leader']);

    // 已建会话快照不变：成员集不含 inst-b；is_leader 仍指向建会时 leader
    const members = getSessionMembersInfo(row.id);
    expect(members.map((m) => m.instanceId).sort()).toEqual(['inst-a', 'inst-leader']);
    expect(members.find((m) => m.instanceId === 'inst-leader')?.isLeader).toBe(true);
    expect(members.find((m) => m.instanceId === 'inst-a')?.isLeader).toBe(false);
  });

  it('团队不存在：抛明确错误，零建会副作用', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    expect(() =>
      createCollabSession('ws1', null, { type: 'team', teamId: 'team-404' }),
    ).toThrow('团队不存在');
    expect(db.prepare('SELECT id FROM sessions').all()).toEqual([]);
  });

  it('workspace 不存在：抛明确错误', () => {
    expect(() =>
      createCollabSession('ws-nope', null, { type: 'agent', instanceId: 'inst7' }),
    ).toThrow('未找到 workspace');
  });
});
