// electron/tests/im/session-service.test.ts
//
// session-service 测试（v2.0.0 P1 Task 7 建立；v25 Task 9 重写）。
// 覆盖 leader 接待路由改造后的目标解析与用户消息写入全链：
//   - resolveTarget：@ 有效成员直答 / 非 @ → is_leader=1 接待 / 无 leader → null /
//     失效成员（已移出 ws）过滤 / 单成员非 leader（泛化建会）→ null
//   - sendUserMessage 全链：messages INSERT（真实 SQLite）+ touchSessionLastMessage +
//     push session:message + P2P 广播（mock）+ 冲突检测（命中推送 / 失败不阻塞）+
//     路由派发 + readOnly 返回 + applyFirstMessageTitle 接线
//
// 隔离策略：
//   - DB：AP_USER_DATA_DIR 临时目录 + runMigrations + closeDb（v25 schema：
//     workspace_agent_members / workspaces.default_agent_instance_id）
//   - p2p 模块整体 vi.mock（broadcastLocalMessage 替换为 spy，不加载真实网络栈）
//   - 命名接线走真实 session-naming（applyFirstMessageTitle 纯 DB 路径，无 LLM）
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

// logger mock：断言「router 缺席导致派发跳过」的 warn 留痕（防静默死路回归）
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession, addSessionMember, getSession } from '../../src/main/storage/sessions/repo';
import { insertTask } from '../../src/main/storage/tasks/repo';
import { logger } from '../../src/main/logger';
import {
  resolveTarget,
  sendUserMessage,
  setSessionRouter,
  setSessionMainWindow,
} from '../../src/main/im/session-service';

const tmpRoot = path.join(os.tmpdir(), `ap-session-service-${Date.now()}`);

function seedWorkspace(db: ReturnType<typeof getDb>, id: string): void {
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji,
        default_agent_instance_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'WS', '', '/tmp', 0, '@owner:s', '📁', null);
}

function seedAgentDef(db: ReturnType<typeof getDb>, id: string, name: string): void {
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, system_prompt, model_name, icon_emoji)
     VALUES (?, ?, ?, '1', 'p', 'm', '🤖')`,
  ).run(id, name, name.toLowerCase());
}

function seedMember(
  db: ReturnType<typeof getDb>,
  instanceId: string,
  defId: string,
  opts?: { lastRunning?: number },
): void {
  db.prepare(
    `INSERT INTO workspace_agent_members
       (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
     VALUES (?, 'ws1', ?, ?, ?)`,
  ).run(instanceId, defId, `@${instanceId}:s`, opts?.lastRunning ?? 1);
}

function makeFakeWindow(): { win: BrowserWindow; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
  return { win, send };
}

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
  setSessionRouter(null);
  setSessionMainWindow(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('resolveTarget（leader 接待语义，spec §4.6 / D5）', () => {
  it('@ 有效成员 → 该成员直答（mention 顺序优先，非成员 mention 跳过）', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedAgentDef(db, 'def-b', 'B');
    seedMember(db, 'inst-a', 'def-a');
    seedMember(db, 'inst-b', 'def-b');
    const s = insertSession({ workspaceId: 'ws1', title: '团队会话' });
    addSessionMember(s.id, 'inst-a', true);
    addSessionMember(s.id, 'inst-b', false);

    expect(resolveTarget(s.id, ['inst-not-member', 'inst-b'])).toBe('inst-b');
    expect(resolveTarget(s.id, ['inst-b', 'inst-a'])).toBe('inst-b');
  });

  it('非 @ 消息 → is_leader=1 成员接待（多成员会话）', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedAgentDef(db, 'def-b', 'B');
    seedMember(db, 'inst-a', 'def-a');
    seedMember(db, 'inst-b', 'def-b');
    const s = insertSession({ workspaceId: 'ws1', title: '团队会话' });
    addSessionMember(s.id, 'inst-a', true);
    addSessionMember(s.id, 'inst-b', false);

    expect(resolveTarget(s.id, [])).toBe('inst-a');
  });

  it('无 leader 的多成员会话（历史会话）→ null（不派发任何 agent）', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedAgentDef(db, 'def-b', 'B');
    seedMember(db, 'inst-a', 'def-a');
    seedMember(db, 'inst-b', 'def-b');
    const s = insertSession({ workspaceId: 'ws1', title: '历史会话' });
    addSessionMember(s.id, 'inst-a', false);
    addSessionMember(s.id, 'inst-b', false);

    expect(resolveTarget(s.id, [])).toBeNull();
  });

  it('单成员 is_leader=1（快速/单 agent 会话形状）→ 接待', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedMember(db, 'inst-a', 'def-a');
    const s = insertSession({ workspaceId: 'ws1', title: '快速会话' });
    addSessionMember(s.id, 'inst-a', true);

    expect(resolveTarget(s.id, [])).toBe('inst-a');
  });

  it('单成员 is_leader=0（泛化 createSession 建会）→ null（发言不触发派发）', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedMember(db, 'inst-a', 'def-a');
    const s = insertSession({ workspaceId: 'ws1', title: '系统会话' });
    addSessionMember(s.id, 'inst-a', false);

    expect(resolveTarget(s.id, [])).toBeNull();
  });

  it('失效成员（已移出 ws，快照行级联清理）：@ 失效成员 → 回退 leader 接待', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedAgentDef(db, 'def-b', 'B');
    seedMember(db, 'inst-a', 'def-a');
    seedMember(db, 'inst-b', 'def-b');
    const s = insertSession({ workspaceId: 'ws1', title: '团队会话' });
    addSessionMember(s.id, 'inst-a', true);
    addSessionMember(s.id, 'inst-b', false);

    // 生产失效路径：removeMember 删 workspace_agent_members 行 → session_members
    // 快照行由 FK ON DELETE CASCADE 级联清理（v25 schema）
    db.prepare('DELETE FROM workspace_agent_members WHERE instance_id = ?').run('inst-b');

    // @ 已移出成员 → mention 未命中 → leader 接待
    expect(resolveTarget(s.id, ['inst-b'])).toBe('inst-a');
    expect(resolveTarget(s.id, [])).toBe('inst-a');
  });

  it('leader 自身失效（已移出 ws）→ 非 @ 消息不派发', () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedMember(db, 'inst-a', 'def-a');
    const s = insertSession({ workspaceId: 'ws1', title: '团队会话' });
    addSessionMember(s.id, 'inst-a', true);
    db.prepare('DELETE FROM workspace_agent_members WHERE instance_id = ?').run('inst-a');

    expect(resolveTarget(s.id, [])).toBeNull();
  });
});

describe('sendUserMessage 全链', () => {
  it('完整链路：INSERT → touch → push session:message → P2P 广播 → 路由到 leader → 返回 readOnly=false', async () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedMember(db, 'inst-a', 'def-a');
    const s = insertSession({ workspaceId: 'ws1', title: '快速会话' });
    addSessionMember(s.id, 'inst-a', true);

    const { win, send } = makeFakeWindow();
    setSessionMainWindow(win);
    const { router, routeUserChat } = makeSpyRouter();
    setSessionRouter(router);

    const result = await sendUserMessage({ sessionId: s.id, body: '你好' });
    expect(result).toEqual({ readOnly: false });

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

    const after = db
      .prepare('SELECT last_message_at FROM sessions WHERE id = ?')
      .get(s.id) as { last_message_at: number | null };
    expect(after.last_message_at).not.toBeNull();

    expect(send).toHaveBeenCalledWith(
      'session:message',
      expect.objectContaining({ id: rows[0]?.id, sessionId: s.id, sender: 'owner', body: '你好' }),
    );

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledWith({
      roomId: s.id,
      sender: 'owner',
      body: '你好',
      eventType: 'm.room.message',
    });

    expect(routeUserChat).toHaveBeenCalledTimes(1);
    expect(routeUserChat).toHaveBeenCalledWith({ sessionId: s.id, assignmentId: 'inst-a', body: '你好' });
  });

  it('mention 命中时按 mention 路由（多成员会话，leader 不插嘴）', async () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedAgentDef(db, 'def-b', 'B');
    seedMember(db, 'inst-a', 'def-a');
    seedMember(db, 'inst-b', 'def-b');
    const s = insertSession({ workspaceId: 'ws1', title: '团队会话' });
    addSessionMember(s.id, 'inst-a', true);
    addSessionMember(s.id, 'inst-b', false);

    const { router, routeUserChat } = makeSpyRouter();
    setSessionRouter(router);

    await sendUserMessage({ sessionId: s.id, body: '交给 b 做', mentionedInstanceIds: ['inst-b'] });

    expect(routeUserChat).toHaveBeenCalledWith({ sessionId: s.id, assignmentId: 'inst-b', body: '交给 b 做' });
  });

  it('无 leader 多成员（无目标）→ 不调 router，消息仍落库，readOnly=false', async () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedAgentDef(db, 'def-b', 'B');
    seedMember(db, 'inst-a', 'def-a');
    seedMember(db, 'inst-b', 'def-b');
    const s = insertSession({ workspaceId: 'ws1', title: '历史会话' });
    addSessionMember(s.id, 'inst-a', false);
    addSessionMember(s.id, 'inst-b', false);

    const { router, routeUserChat } = makeSpyRouter();
    setSessionRouter(router);

    const result = await sendUserMessage({ sessionId: s.id, body: '没人接' });

    expect(routeUserChat).not.toHaveBeenCalled();
    expect(result).toEqual({ readOnly: false });
    const rows = db.prepare('SELECT id FROM messages WHERE session_id = ?').all(s.id) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it('全部成员失效 → 消息仅落库不派发，返回 readOnly=true', async () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedMember(db, 'inst-a', 'def-a');
    const s = insertSession({ workspaceId: 'ws1', title: '孤儿会话' });
    addSessionMember(s.id, 'inst-a', true);
    db.prepare('DELETE FROM workspace_agent_members WHERE instance_id = ?').run('inst-a');

    const { router, routeUserChat } = makeSpyRouter();
    setSessionRouter(router);

    const result = await sendUserMessage({ sessionId: s.id, body: '只读' });

    expect(result).toEqual({ readOnly: true });
    expect(routeUserChat).not.toHaveBeenCalled();
    const rows = db.prepare('SELECT id FROM messages WHERE session_id = ?').all(s.id) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it('首条用户消息接线 applyFirstMessageTitle：占位标题截断为前 20 字', async () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedMember(db, 'inst-a', 'def-a');
    const s = insertSession({ workspaceId: 'ws1', title: '新会话', titleAuto: true });
    addSessionMember(s.id, 'inst-a', true);

    const { router } = makeSpyRouter();
    setSessionRouter(router);

    await sendUserMessage({ sessionId: s.id, body: '帮我写一个登录页面，要求支持手机号验证码登录' });

    const after = getSession(s.id)!;
    expect(after.title).toBe('帮我写一个登录页面，要求支持手机号验证码');
    expect(after.titleAuto).toBe(true);
  });

  it('非占位标题（用户已命名）→ 首条消息不改标题', async () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedMember(db, 'inst-a', 'def-a');
    const s = insertSession({ workspaceId: 'ws1', title: '我的会话', titleAuto: false });
    addSessionMember(s.id, 'inst-a', true);

    const { router } = makeSpyRouter();
    setSessionRouter(router);

    await sendUserMessage({ sessionId: s.id, body: '保持标题' });

    expect(getSession(s.id)!.title).toBe('我的会话');
  });

  it('无 router（未注入）→ 不抛错且消息仍落库，router 缺席留 warn 痕', async () => {
    const db = getDb();
    seedWorkspace(db, 'ws1');
    seedAgentDef(db, 'def-a', 'A');
    seedMember(db, 'inst-a', 'def-a');
    const s = insertSession({ workspaceId: 'ws1', title: '快速会话' });
    addSessionMember(s.id, 'inst-a', true);

    await expect(sendUserMessage({ sessionId: s.id, body: '静默' })).resolves.toEqual({ readOnly: false });

    const rows = db.prepare('SELECT id FROM messages WHERE session_id = ?').all(s.id) as unknown[];
    expect(rows).toHaveLength(1);
    // 目标已解析但 router 缺席 → warn 留痕（不再静默死路）
    expect(logger.warn).toHaveBeenCalledWith(
      '路由目标已解析但 RouterService 未就绪，消息跳过派发',
      expect.objectContaining({ sessionId: s.id, target: 'inst-a' }),
    );
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
    seedAgentDef(db, 'def-a', 'A');
    seedMember(db, 'inst-a', 'def-a');
    const s = insertSession({ workspaceId: 'ws1', title: '快速会话' });
    addSessionMember(s.id, 'inst-a', true);

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
    seedAgentDef(db, 'def-a', 'A');
    seedMember(db, 'inst-a', 'def-a');
    const s = insertSession({ workspaceId: 'ws1', title: '快速会话' });
    addSessionMember(s.id, 'inst-a', true);
    db.exec('DROP TABLE tasks');

    const { router, routeUserChat } = makeSpyRouter();
    setSessionRouter(router);

    await expect(sendUserMessage({ sessionId: s.id, body: '照常工作' })).resolves.toEqual({ readOnly: false });

    const rows = db.prepare('SELECT id FROM messages WHERE session_id = ?').all(s.id) as unknown[];
    expect(rows).toHaveLength(1);
    expect(routeUserChat).toHaveBeenCalledTimes(1);
  });
});
