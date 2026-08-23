// electron/tests/storage/event-buffer.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';
import { listEventsByMessage } from '../../src/main/storage/messages/events-repo';
import { MessageEventBuffer } from '../../src/main/storage/messages/event-buffer';

const tmpRoot = path.join(os.tmpdir(), `ap-buf-${Date.now()}`);

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

describe('MessageEventBuffer', () => {
  it('append 后立即 flush 落盘', () => {
    const msgId = insertMessage({ sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '' }).id;
    const buf = new MessageEventBuffer({ flushMs: 1000 }); // 大窗口避免自动 flush
    buf.append({ messageId: msgId, eventType: 'thinking_delta', payload: { delta: 'h' } });
    expect(buf.pendingCount()).toBe(1);
    buf.flush();
    expect(buf.pendingCount()).toBe(0);
    expect(listEventsByMessage(msgId).length).toBe(1);
    buf.destroy();
  });

  it('达到 flushBatch 阈值立即 flush', () => {
    const msgId = insertMessage({ sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '' }).id;
    const buf = new MessageEventBuffer({ flushMs: 1000, flushBatch: 3 });
    buf.append({ messageId: msgId, eventType: 'text_delta', payload: { d: 'a' } });
    buf.append({ messageId: msgId, eventType: 'text_delta', payload: { d: 'b' } });
    expect(buf.pendingCount()).toBe(2);
    buf.append({ messageId: msgId, eventType: 'text_delta', payload: { d: 'c' } });
    // 第 3 条触发自动 flush
    expect(buf.pendingCount()).toBe(0);
    expect(listEventsByMessage(msgId).length).toBe(3);
    buf.destroy();
  });

  it('flushMs 时间窗口触发自动 flush', async () => {
    const msgId = insertMessage({ sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '' }).id;
    const buf = new MessageEventBuffer({ flushMs: 30 });
    buf.append({ messageId: msgId, eventType: 'text_delta', payload: { d: 'a' } });
    expect(buf.pendingCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(buf.pendingCount()).toBe(0);
    expect(listEventsByMessage(msgId).length).toBe(1);
    buf.destroy();
  });

  it('onFlush 回调收到 batch（用于 IPC 推送）', () => {
    const msgId = insertMessage({ sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '' }).id;
    const flushed = vi.fn();
    const buf = new MessageEventBuffer({ flushMs: 1000, onFlush: flushed });
    buf.append({ messageId: msgId, eventType: 'thinking_delta', payload: { delta: 'h' } });
    buf.append({ messageId: msgId, eventType: 'text_delta', payload: { delta: 't' } });
    buf.flush();
    expect(flushed).toHaveBeenCalledOnce();
    const events = flushed.mock.calls[0][0];
    expect(events.length).toBe(2);
    expect(events[0].eventType).toBe('thinking_delta');
    buf.destroy();
  });

  it('多 message 交错 append，seq 按 message 维度自增', () => {
    const msgId1 = insertMessage({ sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '' }).id;
    const msgId2 = insertMessage({ sessionId: 'r1', sender: '@b:home', eventType: 'm.room.message', body: '' }).id;
    const buf = new MessageEventBuffer({ flushMs: 1000 });
    buf.append({ messageId: msgId1, eventType: 'text_delta', payload: {} });
    buf.append({ messageId: msgId2, eventType: 'text_delta', payload: {} });
    buf.append({ messageId: msgId1, eventType: 'text_delta', payload: {} });
    buf.flush();
    const e1 = listEventsByMessage(msgId1);
    const e2 = listEventsByMessage(msgId2);
    expect(e1.map((e) => e.seq)).toEqual([0, 1]);
    expect(e2.map((e) => e.seq)).toEqual([0]);
    buf.destroy();
  });

  it('destroy 后定时器清理（不再自动 flush）', async () => {
    const msgId = insertMessage({ sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: '' }).id;
    const buf = new MessageEventBuffer({ flushMs: 30 });
    buf.append({ messageId: msgId, eventType: 'text_delta', payload: {} });
    buf.destroy();
    await new Promise((r) => setTimeout(r, 80));
    // destroy 后定时器已清，未 flush 的数据不落盘
    expect(listEventsByMessage(msgId).length).toBe(0);
  });
});