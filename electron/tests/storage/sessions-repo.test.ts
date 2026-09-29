// electron/tests/storage/sessions-repo.test.ts
//
// sessions / session_members 表 CRUD 测试（v23 会话内核；v25 概念模型更换）。
// 覆盖：插入默认值（含 titleAuto）/ 列表排序 / 重命名 / 删除级联清成员 /
//       settings 合并语义 / resolveMaxToolCalls 解析优先级（session 覆盖 > global）/
//       成员增删 / 重复添加幂等 / is_leader 写读回。
//
// DB 隔离沿用仓库既定模式（参考 messages-repo.test.ts / migration-v25.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - runMigrations() 跑到最新（v25：session_members.instance_id/is_leader、sessions.title_auto）
//   - closeDb() 在 afterEach 复位单例；foreign_keys = ON（级联删除依赖此 PRAGMA）
//
// v25 fixture 变化（对齐 migration v25 schema）：
//   - workspaces 无 team_session_id / coordinator_instance_id
//   - agent_assignments → workspace_agent_members（无 role/parent/enabled）
//   - 同 ws 同 def 唯一（UNIQUE 索引）→ 第二个成员需配第二个 def
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertSession,
  getSession,
  listSessionsByWorkspace,
  listAllSessions,
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

  // 外键依赖：workspaces → agent_definitions → workspace_agent_members
  //（session_members.instance_id 有 FK 指向 members 表）
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('ws1', 'WS', '', '/tmp', 0, '@owner:s', '📁');
  for (const [defId, slug] of [['def1', 'a'], ['def2', 'b']] as const) {
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, system_prompt, model_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(defId, defId.toUpperCase(), slug, '1', 'p', 'm');
  }
  for (const [instId, defId] of [['inst1', 'def1'], ['inst2', 'def2']] as const) {
    db.prepare(
      `INSERT INTO workspace_agent_members
         (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES (?, ?, ?, ?)`,
    ).run(instId, 'ws1', defId, `@${instId}:s`);
  }
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

  it('insertSession 默认 titleAuto=false（v25 自动命名标记），getSession 读回一致', () => {
    const s = insertSession({ workspaceId: 'ws1', title: '会话' });
    expect(s.titleAuto).toBe(false);
    const got = getSession(s.id);
    expect(got?.titleAuto).toBe(false);
    // DB 列默认 0（消费方：快速会话创建/LLM 命名替换，spec D4）
    const row = getDb().prepare('SELECT title_auto FROM sessions WHERE id = ?').get(s.id) as {
      title_auto: number;
    };
    expect(row.title_auto).toBe(0);
  });

  it('listSessionsByWorkspace 排序键 = COALESCE(last_message_at, created_at)：空会话按创建时间居首（IM 惯例），且按 workspace 隔离', () => {
    const sA = insertSession({ workspaceId: 'ws1', title: 'a' });
    const sB = insertSession({ workspaceId: 'ws1', title: 'b' });
    const sC = insertSession({ workspaceId: 'ws1', title: 'c' });
    const sNew = insertSession({ workspaceId: 'ws1', title: '新建空会话' });
    getDb()
      .prepare(
        `INSERT INTO workspaces
           (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('ws-other', 'Other', '', '/tmp/other', 0, '@owner:s', '📁');
    insertSession({ workspaceId: 'ws-other', title: '别的 ws' });

    // 时间轴严格受控（Date.now() 并发插入可能同值），created_at / last_message_at 双写：
    //   sA   created=1000, msg=9000 → 有效时间 9000
    //   sB   created=5000, 无消息   → 有效时间 5000
    //   sC   created=7000, 无消息   → 有效时间 7000
    //   sNew created=9500, 无消息   → 有效时间 9500（主机 bug 场景：刚建的快速会话）
    // 期望：sNew(9500) → sA(9000) → sC(7000) → sB(5000)
    // 旧契约（NULL 直接 DESC 垫底）为 sA → sC → sB → sNew——新建会话乐观置顶后
    // 切走切回即跳到列表末尾（2026-09-28 主机反馈）
    const db = getDb();
    db.prepare('UPDATE sessions SET created_at = ?, last_message_at = ? WHERE id = ?').run(1000, 9000, sA.id);
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(5000, sB.id);
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(7000, sC.id);
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(9500, sNew.id);

    const list = listSessionsByWorkspace('ws1');
    expect(list.map((s) => s.id)).toEqual([sNew.id, sA.id, sC.id, sB.id]);
    expect(list.every((s) => s.workspaceId === 'ws1')).toBe(true);
  });

  it('消息到达重排：旧会话收到更新的消息 → 反超新建空会话（微信语义）', () => {
    const sNew = insertSession({ workspaceId: 'ws1', title: '新建空会话' });
    const sOld = insertSession({ workspaceId: 'ws1', title: '旧会话' });
    const db = getDb();
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(9500, sNew.id);
    db.prepare('UPDATE sessions SET created_at = ?, last_message_at = ? WHERE id = ?').run(1000, 9000, sOld.id);

    // 初始：空会话（9500）居首
    expect(listSessionsByWorkspace('ws1').map((s) => s.id)).toEqual([sNew.id, sOld.id]);

    // 旧会话来了 9600 的消息 → 有效时间反超
    db.prepare('UPDATE sessions SET last_message_at = ? WHERE id = ?').run(9600, sOld.id);
    expect(listSessionsByWorkspace('ws1').map((s) => s.id)).toEqual([sOld.id, sNew.id]);
  });

  it('listAllSessions 跨 workspace 全量列表，排序契约与 listSessionsByWorkspace 同源', () => {
    const sEmpty = insertSession({ workspaceId: 'ws1', title: 'ws1 空会话' });
    getDb()
      .prepare(
        `INSERT INTO workspaces
           (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('ws2', 'WS2', '', '/tmp/2', 0, '@owner:s', '📁');
    const sMessaged = insertSession({ workspaceId: 'ws2', title: 'ws2 有消息' });
    const db = getDb();
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(9000, sEmpty.id);
    db.prepare('UPDATE sessions SET created_at = ?, last_message_at = ? WHERE id = ?').run(1000, 8000, sMessaged.id);

    expect(listAllSessions().map((s) => s.id)).toEqual([sEmpty.id, sMessaged.id]);
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

  it('renameSession（Task 9 竞态闭环）：title_auto=1 的会话手动改名 → 单语句同时清 title_auto，飞行中 LLM 守卫 UPDATE 命中 0 行', () => {
    const s = insertSession({ workspaceId: 'ws1', title: '帮我做登录页…', titleAuto: true });
    renameSession(s.id, '手动命名');

    const after = getSession(s.id);
    expect(after?.title).toBe('手动命名');
    expect(after?.titleAuto).toBe(false);

    // 模拟飞行中的 LLM 命名随后到达：session-naming 的竞态锁 UPDATE
    //（WHERE title_auto=1）必须因 title_auto 已被 rename 清零而命中 0 行
    const res = getDb()
      .prepare(
        `UPDATE sessions SET title = ?, title_auto = 0, updated_at = ?
         WHERE id = ? AND title_auto = 1`,
      )
      .run('LLM 迟到标题', Date.now(), s.id);
    expect(res.changes).toBe(0);
    expect(getSession(s.id)?.title).toBe('手动命名');
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

  it('addSessionMember isLeader：缺省 false、显式 true 写读回（v25 快照记 leader）', () => {
    const s = insertSession({ workspaceId: 'ws1', title: 'a' });
    addSessionMember(s.id, 'inst1'); // 缺省 → 非 leader
    addSessionMember(s.id, 'inst2', true); // 显式 leader

    const members = listSessionMembers(s.id);
    expect(members).toHaveLength(2);
    const inst1 = members.find((m) => m.instanceId === 'inst1');
    const inst2 = members.find((m) => m.instanceId === 'inst2');
    expect(inst1?.isLeader).toBe(false);
    expect(inst2?.isLeader).toBe(true);
    // addedAt 是排序键，消费方（成员列表排序）依赖其真实数值
    expect(inst1?.addedAt).toEqual(expect.any(Number));
    expect(inst2?.addedAt).toEqual(expect.any(Number));
  });

  it('addSessionMember 重复添加幂等（INSERT OR IGNORE 语义）', () => {
    const s = insertSession({ workspaceId: 'ws1', title: 'a' });
    addSessionMember(s.id, 'inst1');
    addSessionMember(s.id, 'inst1');
    const members = listSessionMembers(s.id);
    expect(members.length).toBe(1);
    expect(members[0]).toEqual({ instanceId: 'inst1', isLeader: false, addedAt: expect.any(Number) });
  });

  it('removeSessionMember 只删指定成员；listSessionMembers 按 added_at 升序', () => {
    const s = insertSession({ workspaceId: 'ws1', title: 'a' });
    addSessionMember(s.id, 'inst1');
    addSessionMember(s.id, 'inst2');
    expect(listSessionMembers(s.id).map((m) => m.instanceId)).toEqual(['inst1', 'inst2']);

    removeSessionMember(s.id, 'inst1');
    expect(listSessionMembers(s.id).map((m) => m.instanceId)).toEqual(['inst2']);
    // 删不存在的成员是 no-op
    removeSessionMember(s.id, 'inst1');
    expect(listSessionMembers(s.id).map((m) => m.instanceId)).toEqual(['inst2']);
  });
});
