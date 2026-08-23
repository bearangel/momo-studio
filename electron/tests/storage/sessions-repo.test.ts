// electron/tests/storage/sessions-repo.test.ts
//
// sessions / session_members 表 CRUD 测试（v23 会话内核）。
// 覆盖：插入默认值 / 列表排序 / 重命名 / 删除级联清成员 / settings 合并语义 /
//       resolveMaxToolCalls 解析优先级（session 覆盖 > global）/ 成员增删 / 重复添加幂等。
//
// DB 隔离沿用仓库既定模式（参考 messages-repo.test.ts / assignment-capabilities-crud.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - runMigrations() 跑到 v23（sessions / session_members 存在）
//   - closeDb() 在 afterEach 复位单例；foreign_keys = ON（级联删除依赖此 PRAGMA）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertSession,
  getSession,
  listSessionsByWorkspace,
  renameSession,
  deleteSession,
  touchSessionLastMessage,
  updateSessionSettings,
  getSessionSettings,
  addSessionMember,
  removeSessionMember,
  listSessionMembers,
} from '../../src/main/storage/sessions/repo';
import { resolveMaxToolCalls, updateGlobalSettings, getGlobalSettings } from '../../src/main/settings/crud';

const tmpRoot = path.join(os.tmpdir(), `ap-session-repo-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();

  // 外键依赖：workspaces → agent_definitions → agent_assignments（session_members.assignment_id 有 FK）
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('ws1', 'WS', '', '/tmp', 0, '@owner:s', '📁');
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('def1', 'A', 'a', '1', 'declarative', 'p', '[]', 'custom', 'm');
  db.prepare(
    `INSERT INTO agent_assignments
       (instance_id, workspace_id, agent_definition_id, agent_user_id, enabled, role)
     VALUES (?, ?, ?, ?, 1, 'standalone')`,
  ).run('inst1', 'ws1', 'def1', '@bot:s');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('sessions repo', () => {
  it('insertSession 默认 kind=chat，显式 kind=task_execution 生效，getSession 不存在返回 null', () => {
    const s1 = insertSession({ workspaceId: 'ws1', title: '日常聊天' });
    expect(s1.kind).toBe('chat');
    expect(s1.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s1.workspaceId).toBe('ws1');
    expect(s1.settingsJson).toBeNull();
    expect(s1.lastMessageAt).toBeNull();
    expect(s1.createdAt).toBeGreaterThan(0);
    expect(s1.updatedAt).toBe(s1.createdAt);

    const s2 = insertSession({ workspaceId: 'ws1', title: '任务执行', kind: 'task_execution' });
    expect(s2.kind).toBe('task_execution');

    expect(getSession('nonexistent')).toBeNull();
  });

  it('listSessionsByWorkspace 按 lastMessageAt 倒序（NULL 最后）且按 workspace 隔离', () => {
    const s1 = insertSession({ workspaceId: 'ws1', title: 'a' });
    const s2 = insertSession({ workspaceId: 'ws1', title: 'b' });
    const s3 = insertSession({ workspaceId: 'ws1', title: 'c-untouched' });
    getDb()
      .prepare(
        `INSERT INTO workspaces
           (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('ws-other', 'Other', '', '/tmp/other', 0, '@owner:s', '📁');
    insertSession({ workspaceId: 'ws-other', title: '别的 ws' });
    // 直接写 last_message_at 保证时间戳严格递增（Date.now() 并发插入可能同值）
    const db = getDb();
    db.prepare('UPDATE sessions SET last_message_at = 1000 WHERE id = ?').run(s1.id);
    db.prepare('UPDATE sessions SET last_message_at = 2000 WHERE id = ?').run(s2.id);

    const list = listSessionsByWorkspace('ws1');
    // last_message_at DESC：s2(2000) → s1(1000) → s3(NULL 排最后)
    expect(list.map((s) => s.id)).toEqual([s2.id, s1.id, s3.id]);
    expect(list.every((s) => s.workspaceId === 'ws1')).toBe(true);
  });

  it('touchSessionLastMessage 刷新排序键', () => {
    const before = Date.now();
    const s = insertSession({ workspaceId: 'ws1', title: 'a' });
    expect(s.lastMessageAt).toBeNull();
    touchSessionLastMessage(s.id);
    const after = getSession(s.id);
    expect(after?.lastMessageAt).not.toBeNull();
    expect(after?.lastMessageAt ?? 0).toBeGreaterThanOrEqual(before);
  });

  it('renameSession 改 title 并刷新 updatedAt', () => {
    const s = insertSession({ workspaceId: 'ws1', title: '旧标题' });
    renameSession(s.id, '新标题');
    const got = getSession(s.id);
    expect(got?.title).toBe('新标题');
    expect(got?.updatedAt).toBeGreaterThanOrEqual(s.updatedAt);
  });

  it('getSessionSettings 缺省 { maxToolCalls: null, conflictStrategy: "ask" }', () => {
    const s = insertSession({ workspaceId: 'ws1', title: 'a' });
    expect(getSessionSettings(s.id)).toEqual({ maxToolCalls: null, conflictStrategy: 'ask' });
  });

  it('updateSessionSettings 两次 patch 合并不丢字段', () => {
    const s = insertSession({ workspaceId: 'ws1', title: 'a' });
    updateSessionSettings(s.id, { maxToolCalls: 5 });
    updateSessionSettings(s.id, { conflictStrategy: 'queue' });
    expect(getSessionSettings(s.id)).toEqual({ maxToolCalls: 5, conflictStrategy: 'queue' });

    // settings_json 落库（取代 room_settings 表）
    const row = getDb().prepare('SELECT settings_json FROM sessions WHERE id = ?').get(s.id) as {
      settings_json: string;
    };
    expect(JSON.parse(row.settings_json)).toEqual({ maxToolCalls: 5, conflictStrategy: 'queue' });
  });

  it('resolveMaxToolCalls：session 覆盖 > global 覆盖 > 硬编码默认 10', () => {
    const s = insertSession({ workspaceId: 'ws1', title: 'a' });
    // 无任何配置 → 硬编码默认 10
    expect(resolveMaxToolCalls(s.id)).toBe(10);
    // global 覆盖默认
    updateGlobalSettings({ maxToolCalls: 7 });
    expect(getGlobalSettings().maxToolCalls).toBe(7);
    expect(resolveMaxToolCalls(s.id)).toBe(7);
    // session 覆盖 global
    updateSessionSettings(s.id, { maxToolCalls: 3 });
    expect(resolveMaxToolCalls(s.id)).toBe(3);
  });

  it('deleteSession 级联删除 session_members 行', () => {
    const s = insertSession({ workspaceId: 'ws1', title: 'a' });
    addSessionMember(s.id, 'inst1');
    expect(listSessionMembers(s.id).length).toBe(1);
    deleteSession(s.id);
    expect(getSession(s.id)).toBeNull();
    const rows = getDb()
      .prepare('SELECT * FROM session_members WHERE session_id = ?')
      .all(s.id);
    expect(rows.length).toBe(0);
  });

  it('addSessionMember 重复添加幂等（INSERT OR IGNORE 语义）', () => {
    const s = insertSession({ workspaceId: 'ws1', title: 'a' });
    addSessionMember(s.id, 'inst1');
    addSessionMember(s.id, 'inst1');
    const members = listSessionMembers(s.id);
    expect(members.length).toBe(1);
    expect(members[0]).toEqual({ assignmentId: 'inst1', addedAt: expect.any(Number) });
  });

  it('removeSessionMember 只删指定成员；listSessionMembers 按 added_at 升序', () => {
    const db = getDb();
    const s = insertSession({ workspaceId: 'ws1', title: 'a' });
    // 第二个 assignment（同 workspace 可多成员）
    db.prepare(
      `INSERT INTO agent_assignments
         (instance_id, workspace_id, agent_definition_id, agent_user_id, enabled, role)
       VALUES (?, ?, ?, ?, 1, 'sub')`,
    ).run('inst2', 'ws1', 'def1', '@bot2:s');
    addSessionMember(s.id, 'inst1');
    addSessionMember(s.id, 'inst2');
    expect(listSessionMembers(s.id).map((m) => m.assignmentId)).toEqual(['inst1', 'inst2']);

    removeSessionMember(s.id, 'inst1');
    expect(listSessionMembers(s.id).map((m) => m.assignmentId)).toEqual(['inst2']);
    // 删不存在的成员是 no-op
    removeSessionMember(s.id, 'inst1');
    expect(listSessionMembers(s.id).map((m) => m.assignmentId)).toEqual(['inst2']);
  });
});
