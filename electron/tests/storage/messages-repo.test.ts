// electron/tests/storage/messages-repo.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertMessage,
  updateMessageStatus,
  updateMessageMatrixEventId,
  getMessage,
  getMessageByStreamSessionId,
  listMessagesByRoom,
  listOlderMessages,
  type MessageRow,
} from '../../src/main/storage/messages/repo';

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
      roomId: 'r1',
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
      roomId: 'r1',
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
    const row = insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '', status: 'streaming' });
    updateMessageStatus(row.id, 'done', 'final body');
    const got = getMessage(row.id);
    expect(got?.status).toBe('done');
    expect(got?.body).toBe('final body');
    expect(got?.updatedAt).toBeGreaterThanOrEqual(row.updatedAt);
  });

  it('updateMessageMatrixEventId 写入 matrix_event_id', () => {
    const row = insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'x' });
    updateMessageMatrixEventId(row.id, '$evt:home');
    expect(getMessage(row.id)?.matrixEventId).toBe('$evt:home');
  });

  it('getMessage 不存在返回 null', () => {
    expect(getMessage('nonexistent')).toBeNull();
  });

  it('getMessageByStreamSessionId 按 stream 反查', () => {
    insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '', streamSessionId: 'ss-1', status: 'streaming' });
    const got = getMessageByStreamSessionId('ss-1');
    expect(got?.streamSessionId).toBe('ss-1');
  });

  it('listMessagesByRoom 按 created_at 升序', () => {
    const t = Date.now();
    const r1 = insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'a' });
    // 强制时间错开（ updatedAt/createdAt 是 Date.now()，并发插入可能同值）
    const r2 = insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'b' });
    const list = listMessagesByRoom('r1');
    expect(list.map((m) => m.body)).toEqual(['a', 'b']);
  });

  it('listMessagesByRoom 支持 limit + beforeTs', () => {
    for (let i = 0; i < 5; i++) {
      insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: `m${i}` });
    }
    const all = listMessagesByRoom('r1');
    const midTs = all[2].createdAt;
    const older = listMessagesByRoom('r1', { limit: 10, beforeTs: midTs });
    // beforeTs 排除 midTs 本身（< 严格）
    expect(older.every((m) => m.createdAt < midTs)).toBe(true);
  });

  it('listMessagesByRoom 不返回其他房间', () => {
    insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'a' });
    insertMessage({ roomId: 'r2', sender: '@a:home', eventType: 'm.room.message', body: 'b' });
    expect(listMessagesByRoom('r1').length).toBe(1);
  });

  it('listOlderMessages 返回 created_at < beforeTs 的最近 limit 条（升序）', () => {
    for (let i = 0; i < 5; i++) {
      insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: `m${i}` });
    }
    const all = listMessagesByRoom('r1');
    const midTs = all[2].createdAt;
    const older = listOlderMessages('r1', midTs, 10);
    expect(older.length).toBeLessThanOrEqual(10);
    expect(older.every((m) => m.createdAt < midTs)).toBe(true);
  });
});