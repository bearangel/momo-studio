// electron/tests/im/session-ops.test.ts
//
// session-ops（v2.0.0 P1 会话生命周期）纯 SQLite 操作测试。
// 覆盖 brief Step 1：
//   - createSession 带成员
//   - 团队会话禁删抛错（workspaces.team_session_id === id）
//   - getSessionsForWorkspace 按 workspace 过滤
//   - getSessionMembersInfo JOIN agent_assignments + agent_definitions
//     字段：agentName / iconEmoji / role / lastRunning / isCoordinator
//
// DB 隔离沿用 sessions-repo.test.ts 模式：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - runMigrations() 跑到 v23（sessions/session_members/workspaces.team_session_id 存在）
//   - closeDb() 在 afterEach 复位单例；foreign_keys = ON
//   - FK 依赖链：workspaces → agent_definitions → agent_assignments
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import {
  createSession,
  renameSession,
  deleteSessionOp,
  getSessionsForWorkspace,
  getSessionMembersInfo,
} from '../../src/main/im/session-ops';

const tmpRoot = path.join(os.tmpdir(), `ap-session-ops-${Date.now()}`);

/** 用最小列写入 workspaces 行；返回写入的 id。仅本测试用。 */
function seedWorkspace(
  db: ReturnType<typeof getDb>,
  id: string,
  teamSessionId = '',
  coordinatorInstanceId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji,
        team_session_id, coordinator_instance_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'WS', '', '/tmp', 0, '@owner:s', '📁', teamSessionId, coordinatorInstanceId);
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
       (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, name.toLowerCase(), '1', 'declarative', 'p', '[]', 'custom', 'm', iconEmoji);
}

/** 写入一条 agent_assignments 行（含 last_running）。 */
function seedAssignment(
  db: ReturnType<typeof getDb>,
  instanceId: string,
  workspaceId: string,
  defId: string,
  agentUserId: string,
  role: 'standalone' | 'main' | 'sub',
  lastRunning: 0 | 1,
): void {
  db.prepare(
    `INSERT INTO agent_assignments
       (instance_id, workspace_id, agent_definition_id, agent_user_id, enabled, role, last_running)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(instanceId, workspaceId, defId, agentUserId, role, lastRunning);
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
  it('createSession 写入 sessions 行 + 全部 memberAssignmentIds 入会话', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'A', '🤖');
    seedAssignment(db, 'inst1', 'ws1', 'def1', '@bot:s', 'standalone', 1);
    seedAssignment(db, 'inst2', 'ws1', 'def1', '@bot2:s', 'main', 1);

    const row = createSession({
      workspaceId: 'ws1',
      title: '团队讨论',
      memberAssignmentIds: ['inst1', 'inst2'],
    });

    expect(row.workspaceId).toBe('ws1');
    expect(row.title).toBe('团队讨论');
    expect(row.kind).toBe('chat');

    // session_members 已落库
    const memberRows = db
      .prepare('SELECT assignment_id FROM session_members WHERE session_id = ? ORDER BY added_at ASC')
      .all(row.id) as Array<{ assignment_id: string }>;
    expect(memberRows.map((m) => m.assignment_id)).toEqual(['inst1', 'inst2']);
  });

  it('createSession 不指定 memberAssignmentIds 视为空成员（不下异常）', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    const row = createSession({ workspaceId: 'ws1', title: '空会话' });
    const memberRows = db
      .prepare('SELECT assignment_id FROM session_members WHERE session_id = ?')
      .all(row.id) as Array<{ assignment_id: string }>;
    expect(memberRows).toEqual([]);
  });

  it('createSession 支持显式 kind=task_execution', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    const row = createSession({
      workspaceId: 'ws1',
      title: '执行任务',
      memberAssignmentIds: [],
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

  it('createSession 原子性：成员含不存在 assignment_id → 抛错且 sessions 表无残留', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'A', '🤖');
    seedAssignment(db, 'inst1', 'ws1', 'def1', '@bot:s', 'standalone', 1);
    // 'inst-nope' 不存在 → session_members.assignment_id FK 触发异常
    expect(() =>
      createSession({
        workspaceId: 'ws1',
        title: '将失败',
        memberAssignmentIds: ['inst1', 'inst-nope'],
      }),
    ).toThrow();

    // 整笔回滚：sessions 表无残留
    const sessionRows = db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
    expect(sessionRows).toEqual([]);
    const memberRows = db.prepare('SELECT assignment_id FROM session_members').all() as unknown[];
    expect(memberRows).toEqual([]);
  });

  it('deleteSessionOp 非团队会话正常删除；cascade 清空 session_members', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1'); // team_session_id 空 → 非团队会话
    seedAgentDef(db, 'def1', 'A', '🤖');
    seedAssignment(db, 'inst1', 'ws1', 'def1', '@bot:s', 'standalone', 1);
    const row = insertSession({ workspaceId: 'ws1', title: 'a' });
    addSessionMember(row.id, 'inst1');

    deleteSessionOp(row.id);
    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(row.id)).toBeUndefined();
    expect(
      (db.prepare('SELECT assignment_id FROM session_members WHERE session_id = ?').all(row.id) as unknown[])
        .length,
    ).toBe(0);
  });

  it('deleteSessionOp 团队会话（workspaces.team_session_id === id）抛错，不删除', () => {
    const db = getDb();
    // 先 seed workspace（FK：sessions.workspace_id REFERENCES workspaces(id)），
    // workspaces.team_session_id 指向 session id。
    seedWorkspace(db, 'ws1', 'team-sid');
    db.prepare(
      `INSERT INTO sessions
         (id, workspace_id, title, kind, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, 'chat', NULL, ?, ?)`,
    ).run('team-sid', 'ws1', '团队群', 1000, 1000);

    expect(() => deleteSessionOp('team-sid')).toThrow(/团队会话/);
    // 行仍在
    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get('team-sid')).toBeTruthy();
  });

  it('getSessionsForWorkspace 按 workspace 过滤；无参返全部', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    db.prepare(
      `INSERT INTO workspaces
         (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('ws-other', 'Other', '', '/tmp/other', 0, '@owner:s', '📁');

    insertSession({ workspaceId: 'ws1', title: 'a' });
    insertSession({ workspaceId: 'ws1', title: 'b' });
    insertSession({ workspaceId: 'ws-other', title: 'c' });

    const list1 = getSessionsForWorkspace('ws1');
    expect(list1).toHaveLength(2);
    expect(list1.every((s) => s.workspaceId === 'ws1')).toBe(true);

    const list2 = getSessionsForWorkspace('ws-other');
    expect(list2).toHaveLength(1);
    expect(list2[0]?.title).toBe('c');

    // 不传参 → 全部 ws
    const listAll = getSessionsForWorkspace();
    expect(listAll.length).toBeGreaterThanOrEqual(3);

    // 未知 ws → 空数组
    expect(getSessionsForWorkspace('ws-nope')).toEqual([]);
  });

  it('getSessionMembersInfo JOIN agent_assignments+agent_definitions，字段齐全且按 added_at 升序', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1', '', 'inst-coord'); // coordinator_instance_id = inst-coord
    seedAgentDef(db, 'def1', 'Alpha', '🦊');
    seedAgentDef(db, 'def2', 'Beta', '🐼');
    seedAssignment(db, 'inst-coord', 'ws1', 'def1', '@coord:s', 'main', 1);     // 协调
    seedAssignment(db, 'inst-sub', 'ws1', 'def2', '@sub:s', 'sub', 0);          // 已停止

    const row = insertSession({ workspaceId: 'ws1', title: 'a' });
    addSessionMember(row.id, 'inst-sub');   // 先加 sub
    addSessionMember(row.id, 'inst-coord'); // 后加 coord
    // 注：added_at 同毫秒可能相同 → 显式拉开时间戳
    const setAddedAt = db.prepare('UPDATE session_members SET added_at = ? WHERE session_id = ? AND assignment_id = ?');
    setAddedAt.run(1000, row.id, 'inst-sub');
    setAddedAt.run(2000, row.id, 'inst-coord');

    const info = getSessionMembersInfo(row.id);
    expect(info).toHaveLength(2);

    // added_at ASC：sub 在前
    expect(info[0]?.assignmentId).toBe('inst-sub');
    expect(info[0]?.agentName).toBe('Beta');
    expect(info[0]?.iconEmoji).toBe('🐼');
    expect(info[0]?.role).toBe('sub');
    expect(info[0]?.lastRunning).toBe(false);
    expect(info[0]?.isCoordinator).toBe(false);

    expect(info[1]?.assignmentId).toBe('inst-coord');
    expect(info[1]?.agentName).toBe('Alpha');
    expect(info[1]?.iconEmoji).toBe('🦊');
    expect(info[1]?.role).toBe('main');
    expect(info[1]?.lastRunning).toBe(true);
    // coordinator_instance_id === inst-coord → true
    expect(info[1]?.isCoordinator).toBe(true);
  });

  it('getSessionMembersInfo 无成员返回空数组（不抛错）', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    const row = insertSession({ workspaceId: 'ws1', title: 'empty' });
    expect(getSessionMembersInfo(row.id)).toEqual([]);
  });
});
