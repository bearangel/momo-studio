// electron/tests/storage/messages-repo.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertMessage,
  updateMessageStatus,
  getMessage,
  getMessageByStreamSessionId,
  listMessagesBySession,
  listRecentMessagesBySession,
  listOlderMessages,
  listMessagesByStreamSessionId,
  deleteMessages,
  countMessagesBySession,
  getFirstUserMessage,
  type MessageRow,
} from '../../src/main/storage/messages/repo';
import { insertEvent } from '../../src/main/storage/messages/events-repo';
import { writeCompactSnapshot } from '../../src/main/storage/messages/event-compaction';
import { insertSession, getSession } from '../../src/main/storage/sessions/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-msg-repo-${Date.now()}`);

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

describe('messages repo', () => {
  it('insertMessage 自动生成 id/createdAt/updatedAt，默认 status=done source=local', () => {
    const row = insertMessage({
      sessionId: 'r1',
      sender: '@a:home',
      eventType: 'm.room.message',
      body: 'hello',
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.status).toBe('done');
    expect(row.source).toBe('local');
    expect(row.createdAt).toBeGreaterThan(0);
    expect(row.updatedAt).toBe(row.createdAt);
    expect(row.body).toBe('hello');
  });

  it('insertMessage 支持自定义 id 和 streaming 状态', () => {
    const row = insertMessage({
      id: 'm-fixed',
      sessionId: 'r1',
      sender: '@a:home',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-1',
      status: 'streaming',
    });
    expect(row.id).toBe('m-fixed');
    expect(row.streamSessionId).toBe('ss-1');
    expect(row.status).toBe('streaming');
  });

  it('updateMessageStatus 更新 status 和 body', () => {
    const row = insertMessage({ sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '', status: 'streaming' });
    updateMessageStatus(row.id, 'done', 'final body');
    const got = getMessage(row.id);
    expect(got?.status).toBe('done');
    expect(got?.body).toBe('final body');
    expect(got?.updatedAt).toBeGreaterThanOrEqual(row.updatedAt);
  });

  it('getMessage 不存在返回 null', () => {
    expect(getMessage('nonexistent')).toBeNull();
  });

  it('getMessageByStreamSessionId 按 stream 反查', () => {
    insertMessage({ sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '', streamSessionId: 'ss-1', status: 'streaming' });
    const got = getMessageByStreamSessionId('ss-1');
    expect(got?.streamSessionId).toBe('ss-1');
  });

  it('listMessagesBySession 按 created_at 升序', () => {
    const t = Date.now();
    const r1 = insertMessage({ sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'a' });
    // 强制时间错开（ updatedAt/createdAt 是 Date.now()，并发插入可能同值）
    const r2 = insertMessage({ sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'b' });
    const list = listMessagesBySession('r1');
    expect(list.map((m) => m.body)).toEqual(['a', 'b']);
  });

  it('listMessagesBySession 支持 limit + beforeTs', () => {
    for (let i = 0; i < 5; i++) {
      insertMessage({ sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: `m${i}` });
    }
    const all = listMessagesBySession('r1');
    const midTs = all[2]!.createdAt;
    const older = listMessagesBySession('r1', { limit: 10, beforeTs: midTs });
    // beforeTs 排除 midTs 本身（< 严格）
    expect(older.every((m) => m.createdAt < midTs)).toBe(true);
  });

  it('listMessagesBySession 不返回其他房间', () => {
    insertMessage({ sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'a' });
    insertMessage({ sessionId: 'r2', sender: '@a:home', eventType: 'm.room.message', body: 'b' });
    expect(listMessagesBySession('r1').length).toBe(1);
  });

  it('listOlderMessages 返回 created_at < beforeTs 的最近 limit 条（升序）', () => {
    for (let i = 0; i < 5; i++) {
      insertMessage({ sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: `m${i}` });
    }
    const all = listMessagesBySession('r1');
    const midTs = all[2]!.createdAt;
    const older = listOlderMessages('r1', midTs, 10);
    expect(older.length).toBeLessThanOrEqual(10);
    expect(older.every((m) => m.createdAt < midTs)).toBe(true);
  });

  it('listMessagesByStreamSessionId 命中本体与 #roll/#seg 后缀行，不含他流', () => {
    insertMessage({ id: 'm-base', sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'b', streamSessionId: 'ss-1' });
    insertMessage({ id: 'm-roll', sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'r', streamSessionId: 'ss-1#roll1' });
    insertMessage({ id: 'm-other', sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'o', streamSessionId: 'ss-2' });
    const rows = listMessagesByStreamSessionId('ss-1');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['m-base', 'm-roll']);
  });
});
// === listRecentMessagesBySession：导出「最近 N 条」语义 ===
// 根因：listMessagesBySession({limit}) 是 ASC+LIMIT = 最早 N 条，导出 UI 却宣称
// 「最近 N 条」。导出 handler 改用本函数取最新 N 条并按时间升序返回。
describe('listRecentMessagesBySession', () => {
  it('取最新 N 条且输出按时间升序（与显示侧时序一致）', () => {
    const ids = ['m-old1', 'm-old2', 'm-mid', 'm-new1', 'm-new2'];
    for (const id of ids) {
      insertMessage({ id, sessionId: 'r-recent', sender: '@u:home', eventType: 'm.room.message', body: id });
    }
    // insertMessage 的 created_at 全取 Date.now()——显式改写以获得确定性时序
    const db = getDb();
    ids.forEach((id, i) => {
      db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(1000 + i * 10, id);
    });

    const rows = listRecentMessagesBySession('r-recent', 3);
    // 最新 3 条 = m-mid/m-new1/m-new2，按时间升序输出
    expect(rows.map((r) => r.id)).toEqual(['m-mid', 'm-new1', 'm-new2']);
  });

  it('总数不足 N 时全量返回（升序）', () => {
    insertMessage({ id: 'only-1', sessionId: 'r-recent2', sender: '@u:home', eventType: 'm.room.message', body: 'x' });
    const rows = listRecentMessagesBySession('r-recent2', 50);
    expect(rows.map((r) => r.id)).toEqual(['only-1']);
  });

  it('空会话返回空数组', () => {
    expect(listRecentMessagesBySession('r-empty', 10)).toEqual([]);
  });
});

// === A1（spec 2026-09-14 §3）：最近窗口过滤 ===

/** 显式改写 created_at（窗口语义测试需要确定性时序；生产无此路径） */
function setCreatedAt(id: string, ts: number): void {
  getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(ts, id);
}

describe('listRecentMessagesBySession opts（A1 最近窗口过滤）', () => {
  /** seed 5 行（m1..m5，created_at = 1000..5000 严格递增） */
  function seed5(): void {
    for (let i = 1; i <= 5; i++) {
      const row = insertMessage({
        sessionId: 'r-window',
        sender: '@a:home',
        eventType: 'm.room.message',
        body: `m${i}`,
      });
      setCreatedAt(row.id, i * 1000);
    }
  }

  it('limit=3 返回最新 3 条且输出 ASC', () => {
    seed5();
    const rows = listRecentMessagesBySession('r-window', 3);
    expect(rows.map((r) => r.body)).toEqual(['m3', 'm4', 'm5']);
  });

  it('afterTs：仅拉 created_at 严格大于游标的最近 N 条', () => {
    seed5();
    const rows = listRecentMessagesBySession('r-window', 10, { afterTs: 3000 });
    expect(rows.map((r) => r.body)).toEqual(['m4', 'm5']);
  });

  it('beforeTs 与 afterTs 组合成区间窗口', () => {
    seed5();
    const rows = listRecentMessagesBySession('r-window', 10, { afterTs: 1000, beforeTs: 4000 });
    expect(rows.map((r) => r.body)).toEqual(['m2', 'm3']);
  });
});

describe('deleteMessages（逐层撤回的消息删除面）', () => {
  function seedWsAndSession(sessionKey: string): { sessionId: string } {
    getDb()
      .prepare(
        `INSERT INTO workspaces
           (id, name, description, directory_path, git_initialized, owner_id, icon_emoji,
            default_agent_instance_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`ws-${sessionKey}`, 'WS', '', '/tmp', 0, '@owner:s', '📁', null);
    const sess = insertSession({ workspaceId: `ws-${sessionKey}`, title: `t-${sessionKey}` });
    return { sessionId: sess.id };
  }

  it('删除行 + message_events FK 级联 + compact 快照清理 + last_message_at 重算', () => {
    const { sessionId } = seedWsAndSession('s-del');
    const owner = insertMessage({ sessionId, sender: 'owner', eventType: 'm.room.message', body: '问' });
    const agent = insertMessage({
      sessionId,
      sender: 'agent-x',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-del-1',
      status: 'streaming',
    });
    insertEvent({ messageId: agent.id, seq: 0, eventType: 'text_delta', payload: { delta: '答' } });
    writeCompactSnapshot(agent.id);
    expect(listMessagesBySession(sessionId)).toHaveLength(2);
    expect(getSession(sessionId)!.lastMessageAt).toBeNull();

    const { deletedIds, affectedSessions } = deleteMessages([owner.id, agent.id], { sessionId });

    expect(deletedIds.sort()).toEqual([owner.id, agent.id].sort());
    expect(affectedSessions).toEqual([sessionId]);
    expect(listMessagesBySession(sessionId)).toHaveLength(0);
    // 事件与压缩快照随行清理
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM message_events WHERE message_id = ?').get(agent.id)).toEqual({ n: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM message_compact_events WHERE message_id = ?').get(agent.id)).toEqual({ n: 0 });
    // 会话清空 → last_message_at 归 NULL
    expect(getSession(sessionId)!.lastMessageAt).toBeNull();
  });

  it('部分删除 → last_message_at 重算为剩余最新消息时间', () => {
    const { sessionId } = seedWsAndSession('s-part');
    const m1 = insertMessage({ sessionId, sender: 'owner', eventType: 'm.room.message', body: 'a' });
    const m2 = insertMessage({ sessionId, sender: 'agent-x', eventType: 'm.room.message', body: 'b' });
    const m3 = insertMessage({ sessionId, sender: 'owner', eventType: 'm.room.message', body: 'c' });

    const { deletedIds } = deleteMessages([m3.id], { sessionId });

    expect(deletedIds).toEqual([m3.id]);
    expect(listMessagesBySession(sessionId).map((r) => r.id)).toEqual([m1.id, m2.id]);
    expect(getSession(sessionId)!.lastMessageAt).toBe(m2.createdAt);
  });

  it('sessionId 过滤：他会话同 id 请求不误删（防跨会话误删）', () => {
    const mine = seedWsAndSession('s-mine');
    const other = seedWsAndSession('s-other');
    const mineMsg = insertMessage({ sessionId: mine.sessionId, sender: 'owner', eventType: 'm.room.message', body: 'x' });
    const otherMsg = insertMessage({ sessionId: other.sessionId, sender: 'owner', eventType: 'm.room.message', body: 'y' });

    const { deletedIds } = deleteMessages([otherMsg.id], { sessionId: mine.sessionId });

    expect(deletedIds).toEqual([]);
    expect(getMessage(otherMsg.id)).not.toBeNull();
    expect(getMessage(mineMsg.id)).not.toBeNull();
  });

  it('错误路径：空 ids 与不存在 id 均空结果不抛错', () => {
    const { sessionId } = seedWsAndSession('s-empty');
    expect(deleteMessages([], { sessionId })).toEqual({ deletedIds: [], affectedSessions: [] });
    expect(deleteMessages(['no-such-id'], { sessionId })).toEqual({ deletedIds: [], affectedSessions: [] });
    expect(deleteMessages(['no-such-id'])).toEqual({ deletedIds: [], affectedSessions: [] });
  });
});

describe('countMessagesBySession / getFirstUserMessage（跨会话引用）', () => {
  // sessions.workspace_id 外键真实存在（REFERENCES workspaces + foreign_keys=ON），
  // brief 模板的 insertSession({ workspaceId: 'w1' }) 不建 workspace 会触发 FK 约束失败——
  // 按本文件 deleteMessages 套件先例补 seed（其余断言与 brief 一致）。
  // workspace id 用 randomUUID：同一用例内多次 seed（t / t2）不得撞主键
  function seedWsAndSession(title: string): { sessionId: string } {
    const workspaceId = `ws-${randomUUID()}`;
    getDb()
      .prepare(
        `INSERT INTO workspaces
           (id, name, description, directory_path, git_initialized, owner_id, icon_emoji,
            default_agent_instance_id)
         VALUES (?, 'WS', '', '/tmp', 0, '@owner:s', '📁', null)`,
      )
      .run(workspaceId);
    const sess = insertSession({ workspaceId, title });
    return { sessionId: sess.id };
  }

  it('countMessagesBySession：按会话计数，不含其它会话', () => {
    const s = seedWsAndSession('t');
    insertMessage({ sessionId: s.sessionId, sender: 'owner', eventType: 'm.room.message', body: 'a' });
    insertMessage({ sessionId: s.sessionId, sender: 'coder-1', eventType: 'm.room.message', body: 'b' });
    // messages.session_id 无外键（room_id RENAME 而来），可插不存在会话的行验证隔离
    insertMessage({ sessionId: 'other', sender: 'owner', eventType: 'm.room.message', body: 'c' });
    expect(countMessagesBySession(s.sessionId)).toBe(2);
    expect(countMessagesBySession('nonexistent')).toBe(0);
  });

  it('getFirstUserMessage：取首条 sender=owner 消息；无用户消息 / 不存在 → null', () => {
    const s = seedWsAndSession('t');
    insertMessage({ sessionId: s.sessionId, sender: 'coder-1', eventType: 'm.room.message', body: 'agent 先说' });
    const first = insertMessage({ sessionId: s.sessionId, sender: 'owner', eventType: 'm.room.message', body: '用户第一条' });
    insertMessage({ sessionId: s.sessionId, sender: 'owner', eventType: 'm.room.message', body: '用户第二条' });
    expect(getFirstUserMessage(s.sessionId)?.id).toBe(first.id);
    expect(getFirstUserMessage('nonexistent')).toBeNull();
    const s2 = seedWsAndSession('t2');
    insertMessage({ sessionId: s2.sessionId, sender: 'coder-1', eventType: 'm.room.message', body: '只有 agent' });
    expect(getFirstUserMessage(s2.sessionId)).toBeNull();
  });
});
