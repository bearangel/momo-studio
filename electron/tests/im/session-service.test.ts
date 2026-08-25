// electron/tests/im/session-service.test.ts
//
// session-service（v2.0.0 P1 Task 7：用户消息写入 + 目标解析 + 进程内路由）测试。
// 覆盖 brief Step 1：
//   - resolveTarget 四分支：mention 命中 / 单成员自动应答 / 团队会话协调 agent 接待 / 无目标
//   - sendUserMessage 全链：messages INSERT（真实 SQLite）+ touchSessionLastMessage +
//     push session:message + P2P 广播（mock）+ 冲突检测（命中推送 / 失败不阻塞）+ router 路由
//
// 隔离策略：
//   - DB 沿用 session-ops.test.ts 模式（AP_USER_DATA_DIR 临时目录 + runMigrations + closeDb）
//   - p2p 模块整体 vi.mock（broadcastLocalMessage 替换为 spy，不加载真实网络栈）
//   - 窗口引用经 setSessionMainWindow 注入 duck-typed 假窗口（session-service 对 electron
//     仅 type-only import，测试进程无运行时依赖）
//   - router 经 setSessionRouter 注入满足 SessionRouter 结构的 spy 对象
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { BrowserWindow } from 'electron';

const { mockBroadcast } = vi.hoisted(() => ({
  mockBroadcast: vi.fn(),
}));

vi.mock('../../src/main/p2p', () => ({
  broadcastLocalMessage: mockBroadcast,
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { insertTask } from '../../src/main/storage/tasks/repo';
import {
  resolveTarget,
  sendUserMessage,
  setSessionRouter,
  setSessionMainWindow,
} from '../../src/main/im/session-service';

const tmpRoot = path.join(os.tmpdir(), `ap-session-service-${Date.now()}`);

/** 用最小列写入 workspaces 行；teamSessionId/coordinatorInstanceId 按需传入。 */
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

/** 写入一条 agent_definitions 行。 */
function seedAgentDef(
  db: ReturnType<typeof getDb>,
  id: string,
  name: string,
): void {
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, name.toLowerCase(), '1', 'declarative', 'p', '[]', 'custom', 'm', '🤖');
}

/** 写入一条 agent_assignments 行。role 缺省 standalone。 */
function seedAssignment(
  db: ReturnType<typeof getDb>,
  instanceId: string,
  workspaceId: string,
  defId: string,
  role: 'standalone' | 'main' | 'sub' = 'standalone',
): void {
  db.prepare(
    `INSERT INTO agent_assignments
       (instance_id, workspace_id, agent_definition_id, agent_user_id, enabled, role, last_running)
     VALUES (?, ?, ?, ?, 1, ?, 0)`,
  ).run(instanceId, workspaceId, defId, `@${instanceId}:s`, role);
}

/** duck-typed 假窗口：收集 webContents.send 调用（session:message / im:conflict）。 */
function makeFakeWindow(): { win: BrowserWindow; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
  return { win, send };
}

/** 组装一个满足 SessionRouter 结构的 spy router。 */
function makeSpyRouter(): { router: { routeUserChat: ReturnType<typeof vi.fn> }; routeUserChat: ReturnType<typeof vi.fn> } {
  const routeUserChat = vi.fn().mockResolvedValue(undefined);
  return { router: { routeUserChat }, routeUserChat };
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  mockBroadcast.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  // 复位模块级注入，避免跨用例泄漏
  setSessionRouter(null);
  setSessionMainWindow(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('resolveTarget 四分支', () => {
  it('分支1：显式 mention → 返回第一个是本会话成员的被 @ assignment（非成员 mention 跳过）', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'A');
    seedAssignment(db, 'inst-a', 'ws1', 'def1');
    seedAssignment(db, 'inst-b', 'ws1', 'def1');
    const s = insertSession({ workspaceId: 'ws1', title: '群聊' });
    addSessionMember(s.id, 'inst-a');
    addSessionMember(s.id, 'inst-b');

    // mention 列表顺序优先：第一个命中成员的生效
    expect(resolveTarget(s.id, ['inst-not-member', 'inst-b'])).toBe('inst-b');
    expect(resolveTarget(s.id, ['inst-b', 'inst-a'])).toBe('inst-b');
  });

  it('分支2：会话仅 1 个成员 → 自动响应（单聊无需 @）', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'A');
    seedAssignment(db, 'inst-a', 'ws1', 'def1');
    const s = insertSession({ workspaceId: 'ws1', title: '单聊' });
    addSessionMember(s.id, 'inst-a');

    expect(resolveTarget(s.id, [])).toBe('inst-a');
  });

  it('分支2 边界：单成员 + mention 非成员 → mention 未命中回退单成员', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'A');
    seedAssignment(db, 'inst-a', 'ws1', 'def1');
    const s = insertSession({ workspaceId: 'ws1', title: '单聊' });
    addSessionMember(s.id, 'inst-a');

    expect(resolveTarget(s.id, ['inst-elsewhere'])).toBe('inst-a');
  });

  it('分支3：本会话是 workspace 团队会话且有协调 agent → 协调 agent 接待', () => {
    const db = getDb();
    // 团队会话 id 由 workspaces.team_session_id 指向；协调 agent 不要求是会话成员
    // （与原 decide-response 语义一致：协调者负责接待非 @ 消息）
    seedWorkspace(db, 'ws1', 'team-sid', 'inst-coord');
    seedAgentDef(db, 'def1', 'A');
    seedAssignment(db, 'inst-a', 'ws1', 'def1');
    seedAssignment(db, 'inst-b', 'ws1', 'def1');
    db.prepare(
      `INSERT INTO sessions
         (id, workspace_id, title, kind, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, 'chat', NULL, ?, ?)`,
    ).run('team-sid', 'ws1', '团队群', 1000, 1000);
    addSessionMember('team-sid', 'inst-a');
    addSessionMember('team-sid', 'inst-b');

    expect(resolveTarget('team-sid', [])).toBe('inst-coord');
  });

  it('分支3 反例：会话不是 workspace 团队会话（多成员）→ 不走协调接待', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1', 'team-sid-other', 'inst-coord');
    seedAgentDef(db, 'def1', 'A');
    seedAssignment(db, 'inst-a', 'ws1', 'def1');
    seedAssignment(db, 'inst-b', 'ws1', 'def1');
    const s = insertSession({ workspaceId: 'ws1', title: '普通群' });
    addSessionMember(s.id, 'inst-a');
    addSessionMember(s.id, 'inst-b');

    expect(resolveTarget(s.id, [])).toBeNull();
  });

  it('分支3 反例：团队会话但 workspace 无协调 agent → null', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1', 'team-sid', null);
    seedAgentDef(db, 'def1', 'A');
    seedAssignment(db, 'inst-a', 'ws1', 'def1');
    seedAssignment(db, 'inst-b', 'ws1', 'def1');
    db.prepare(
      `INSERT INTO sessions
         (id, workspace_id, title, kind, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, 'chat', NULL, ?, ?)`,
    ).run('team-sid', 'ws1', '团队群', 1000, 1000);
    addSessionMember('team-sid', 'inst-a');
    addSessionMember('team-sid', 'inst-b');

    expect(resolveTarget('team-sid', [])).toBeNull();
  });

  it('分支4：多成员 + 无 mention + 非团队会话 → null（不路由）', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'A');
    seedAssignment(db, 'inst-a', 'ws1', 'def1');
    seedAssignment(db, 'inst-b', 'ws1', 'def1');
    const s = insertSession({ workspaceId: 'ws1', title: '群聊' });
    addSessionMember(s.id, 'inst-a');
    addSessionMember(s.id, 'inst-b');

    expect(resolveTarget(s.id, [])).toBeNull();
  });
});

describe('sendUserMessage 全链', () => {
  it('完整链路：INSERT → touch → push session:message → P2P 广播 → 冲突检测 → 路由', async () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'A');
    seedAssignment(db, 'inst1', 'ws1', 'def1');
    const s = insertSession({ workspaceId: 'ws1', title: '单聊' });
    addSessionMember(s.id, 'inst1');

    const { win, send } = makeFakeWindow();
    setSessionMainWindow(win);
    const { router, routeUserChat } = makeSpyRouter();
    setSessionRouter(router);

    await sendUserMessage({ sessionId: s.id, body: '你好' });

    // 1) messages 表落库（真实 SQLite）
    const rows = db.prepare('SELECT * FROM messages WHERE session_id = ?').all(s.id) as Array<{
      id: string; sender: string; event_type: string; body: string;
      workspace_id: string; source: string; status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sender).toBe('owner');
    expect(rows[0]?.event_type).toBe('m.room.message');
    expect(rows[0]?.body).toBe('你好');
    expect(rows[0]?.workspace_id).toBe('ws1');
    expect(rows[0]?.source).toBe('local');
    expect(rows[0]?.status).toBe('done');

    // 2) touchSessionLastMessage：last_message_at 从 NULL 刷新
    const after = db
      .prepare('SELECT last_message_at FROM sessions WHERE id = ?')
      .get(s.id) as { last_message_at: number | null };
    expect(after.last_message_at).not.toBeNull();

    // 3) 推 renderer：session:message 通道，载荷为完整 MessageRow
    expect(send).toHaveBeenCalledWith(
      'session:message',
      expect.objectContaining({ id: rows[0]?.id, sessionId: s.id, sender: 'owner', body: '你好' }),
    );

    // 4) P2P 广播（SyncMessage 字段名仍为 roomId——值映射 sessionId）
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledWith({
      roomId: s.id,
      sender: 'owner',
      body: '你好',
      eventType: 'm.room.message',
    });

    // 5) 路由到目标 agent（单成员分支自动应答）
    expect(routeUserChat).toHaveBeenCalledTimes(1);
    expect(routeUserChat).toHaveBeenCalledWith({ sessionId: s.id, assignmentId: 'inst1', body: '你好' });
  });

  it('mention 命中时按 mention 路由（多成员会话）', async () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'A');
    seedAssignment(db, 'inst-a', 'ws1', 'def1');
    seedAssignment(db, 'inst-b', 'ws1', 'def1');
    const s = insertSession({ workspaceId: 'ws1', title: '群聊' });
    addSessionMember(s.id, 'inst-a');
    addSessionMember(s.id, 'inst-b');

    const { router, routeUserChat } = makeSpyRouter();
    setSessionRouter(router);

    await sendUserMessage({ sessionId: s.id, body: '交给 b 做', mentionedAssignmentIds: ['inst-b'] });

    expect(routeUserChat).toHaveBeenCalledWith({ sessionId: s.id, assignmentId: 'inst-b', body: '交给 b 做' });
  });

  it('多成员无 mention（无目标）→ 不调 router，消息仍落库', async () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'A');
    seedAssignment(db, 'inst-a', 'ws1', 'def1');
    seedAssignment(db, 'inst-b', 'ws1', 'def1');
    const s = insertSession({ workspaceId: 'ws1', title: '群聊' });
    addSessionMember(s.id, 'inst-a');
    addSessionMember(s.id, 'inst-b');

    const { router, routeUserChat } = makeSpyRouter();
    setSessionRouter(router);

    await sendUserMessage({ sessionId: s.id, body: '没人接' });

    expect(routeUserChat).not.toHaveBeenCalled();
    const rows = db.prepare('SELECT id FROM messages WHERE session_id = ?').all(s.id) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it('无 router（未注入）→ 不抛错且消息仍落库', async () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'A');
    seedAssignment(db, 'inst1', 'ws1', 'def1');
    const s = insertSession({ workspaceId: 'ws1', title: '单聊' });
    addSessionMember(s.id, 'inst1');

    await expect(sendUserMessage({ sessionId: s.id, body: '静默' })).resolves.toBeUndefined();

    const rows = db.prepare('SELECT id FROM messages WHERE session_id = ?').all(s.id) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it('会话不存在 → 抛错（含 sessionId）', async () => {
    seedWorkspace(getDb(), 'ws1');
    await expect(sendUserMessage({ sessionId: 'no-such-session', body: 'x' })).rejects.toThrow(
      /会话不存在/,
    );
  });

  it('冲突命中 → 推 im:conflict 给 renderer（载荷含 newTaskId/currentTaskId）', async () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'A');
    seedAssignment(db, 'inst1', 'ws1', 'def1');
    const s = insertSession({ workspaceId: 'ws1', title: '单聊' });
    addSessionMember(s.id, 'inst1');

    // 当前会话挂一个 in_progress 任务 + 另一个可被 mention 的任务
    insertTask({ id: 'T-1', workspaceId: 'ws1', title: '进行中', creatorUserId: '@owner:s', status: 'in_progress', executionSessionId: s.id });
    insertTask({ id: 'T-2', workspaceId: 'ws1', title: '被提及', creatorUserId: '@owner:s', status: 'pending' });

    const { win, send } = makeFakeWindow();
    setSessionMainWindow(win);
    const { router } = makeSpyRouter();
    setSessionRouter(router);

    await sendUserMessage({ sessionId: s.id, body: '请改为处理 #T-2' });

    expect(send).toHaveBeenCalledWith(
      'im:conflict',
      expect.objectContaining({ newTaskId: 'T-2', currentTaskId: 'T-1' }),
    );
  });

  it('冲突检测失败（tasks 表被删）不阻塞：消息仍落库且路由完成', async () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def1', 'A');
    seedAssignment(db, 'inst1', 'ws1', 'def1');
    const s = insertSession({ workspaceId: 'ws1', title: '单聊' });
    addSessionMember(s.id, 'inst1');
    db.exec('DROP TABLE tasks');

    const { router, routeUserChat } = makeSpyRouter();
    setSessionRouter(router);

    await expect(sendUserMessage({ sessionId: s.id, body: '照常工作' })).resolves.toBeUndefined();

    const rows = db.prepare('SELECT id FROM messages WHERE session_id = ?').all(s.id) as unknown[];
    expect(rows).toHaveLength(1);
    expect(routeUserChat).toHaveBeenCalledTimes(1);
  });
});


describe('resolveTarget 分支2.5（2.0.0 要求）：普通多成员会话含 PM → PM 自动接待', () => {
  it('PM + sub 两个成员的普通会话，无 @ 消息 → 路由到 PM', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-pm', 'PM');
    seedAgentDef(db, 'def-sub', 'Sub');
    seedAssignment(db, 'inst-pm', 'ws1', 'def-pm', 'main');
    seedAssignment(db, 'inst-sub', 'ws1', 'def-sub', 'sub');
    const s = insertSession({ workspaceId: 'ws1', title: '普通群' });
    addSessionMember(s.id, 'inst-pm');
    addSessionMember(s.id, 'inst-sub');

    expect(resolveTarget(s.id, [])).toBe('inst-pm');
  });

  it('无 PM 的多成员会话（两个 standalone）→ 不路由（保持原语义）', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedAgentDef(db, 'def-b', 'B');
    seedAssignment(db, 'inst-a', 'ws1', 'def-a');
    seedAssignment(db, 'inst-b', 'ws1', 'def-b');
    const s = insertSession({ workspaceId: 'ws1', title: '普通群' });
    addSessionMember(s.id, 'inst-a');
    addSessionMember(s.id, 'inst-b');

    expect(resolveTarget(s.id, [])).toBeNull();
  });

  it('多 PM 时取第一个 main 成员（加入序）', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedAgentDef(db, 'def-b', 'B');
    seedAssignment(db, 'inst-a', 'ws1', 'def-a', 'main');
    seedAssignment(db, 'inst-b', 'ws1', 'def-b', 'main');
    const s = insertSession({ workspaceId: 'ws1', title: '双 PM' });
    addSessionMember(s.id, 'inst-a');
    addSessionMember(s.id, 'inst-b');

    expect(resolveTarget(s.id, [])).toBe('inst-a');
  });

  it('@ 指定其他成员优先于 PM 自动接待', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-pm', 'PM');
    seedAgentDef(db, 'def-sub', 'Sub');
    seedAssignment(db, 'inst-pm', 'ws1', 'def-pm', 'main');
    seedAssignment(db, 'inst-sub', 'ws1', 'def-sub', 'sub');
    const s = insertSession({ workspaceId: 'ws1', title: '普通群' });
    addSessionMember(s.id, 'inst-pm');
    addSessionMember(s.id, 'inst-sub');

    expect(resolveTarget(s.id, ['inst-sub'])).toBe('inst-sub');
  });
});
