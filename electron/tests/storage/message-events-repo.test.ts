// electron/tests/storage/message-events-repo.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';
import {
  insertEvent,
  insertEventBatch,
  listEventsByMessage,
  nextSeqForMessage,
} from '../../src/main/storage/messages/events-repo';

const tmpRoot = path.join(os.tmpdir(), `ap-evt-repo-${Date.now()}`);

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

function seedMessage(): string {
  return insertMessage({ roomId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '' }).id;
}

describe('message_events repo', () => {
  it('insertEvent 自动生成 id + createdAt，seq 由调用方控制', () => {
    const msgId = seedMessage();
    const e = insertEvent({ messageId: msgId, seq: 0, eventType: 'thinking_delta', payload: { delta: 'hello' } });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.messageId).toBe(msgId);
    expect(e.seq).toBe(0);
    expect(e.eventType).toBe('thinking_delta');
    expect(e.payload).toEqual({ delta: 'hello' });
    expect(e.createdAt).toBeGreaterThan(0);
  });

  it('nextSeqForMessage 首次返回 0，递增', () => {
    const msgId = seedMessage();
    expect(nextSeqForMessage(msgId)).toBe(0);
    insertEvent({ messageId: msgId, seq: 0, eventType: 'thinking_delta', payload: {} });
    expect(nextSeqForMessage(msgId)).toBe(1);
    insertEvent({ messageId: msgId, seq: 1, eventType: 'text_delta', payload: {} });
    expect(nextSeqForMessage(msgId)).toBe(2);
  });

  it('listEventsByMessage 按 seq 升序', () => {
    const msgId = seedMessage();
    insertEvent({ messageId: msgId, seq: 2, eventType: 'final', payload: { idx: 2 } });
    insertEvent({ messageId: msgId, seq: 0, eventType: 'thinking_delta', payload: { idx: 0 } });
    insertEvent({ messageId: msgId, seq: 1, eventType: 'text_delta', payload: { idx: 1 } });
    const list = listEventsByMessage(msgId);
    expect(list.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('insertEventBatch 单事务批量插入', () => {
    const msgId = seedMessage();
    const rows = Array.from({ length: 100 }, (_, i) => ({
      messageId: msgId,
      seq: i,
      eventType: 'text_delta' as const,
      payload: { idx: i },
    }));
    const start = Date.now();
    insertEventBatch(rows);
    const elapsed = Date.now() - start;
    expect(listEventsByMessage(msgId).length).toBe(100);
    // 性能断言：100 条单事务应 < 50ms（CI 上 better-sqlite3 + WAL）
    expect(elapsed).toBeLessThan(500);
  });

  it('insertEventBatch 空数组是 no-op', () => {
    const msgId = seedMessage();
    insertEventBatch([]);
    expect(listEventsByMessage(msgId).length).toBe(0);
  });

  it('payload 是 JSON 往返（嵌套对象 / 数组）', () => {
    const msgId = seedMessage();
    const payload = { toolName: 'read_file', args: { path: '/a/b/c.ts' }, result: { lines: [1, 2, 3] } };
    insertEvent({ messageId: msgId, seq: 0, eventType: 'tool_call_start', payload });
    const list = listEventsByMessage(msgId);
    expect(list[0].payload).toEqual(payload);
  });
});