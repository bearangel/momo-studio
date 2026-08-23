// electron/tests/agent/stream-relay.test.ts
//
// stream-relay 模块测试（Task 6：从 runtime-manager 平移出的流式 chunk 中继层）。
// 覆盖：
//   1. routeChunkToBuffer：StreamChunk → messages/message_events 落盘映射
//      （含 Task 6 字段迁移：start.sessionId / start.senderAgentId）
//   2. segment_boundary 分段场景（自 runtime-segment.test.ts 平移，字段同步迁移）
//   3. abortStreamBySessionId：注册反转（setAbortResolver 注入）的广播语义
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  __routeChunkToBufferForTest,
  __resetEventBufferForTest,
  __flushEventBufferForTest,
  setAbortResolver,
  abortStreamBySessionId,
} from '../../src/main/agent/stream-relay';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import {
  getMessageByStreamSessionId,
  listMessagesBySession,
} from '../../src/main/storage/messages/repo';
import { listEventsByMessage } from '../../src/main/storage/messages/events-repo';

// === DB 测试夹具 ===

const tmpRoot = path.join(os.tmpdir(), `ap-relay-${Date.now()}`);

function setupDb(): void {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
}

function teardownDb(): void {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
}

// === routeChunkToBuffer：chunk → SQLite 映射 ===

describe('routeChunkToBuffer: chunk → SQLite 映射', () => {
  beforeEach(() => {
    setupDb();
    __resetEventBufferForTest();
  });

  afterEach(() => {
    __resetEventBufferForTest();
    teardownDb();
  });

  it('start chunk 写入 messages 行（sessionId/senderAgentId 映射 session_id/sender）+ status_change event', () => {
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-map-1',
      sessionId: '!room:localhost',
      senderAgentId: '@bot:localhost',
    });
    __flushEventBufferForTest();

    const msg = getMessageByStreamSessionId('ss-map-1');
    expect(msg).not.toBeNull();
    // Task 6 字段迁移：chunk.sessionId → messages.session_id，
    // chunk.senderAgentId（值仍是 bot 的 Matrix userId）→ messages.sender
    expect(msg!.sessionId).toBe('!room:localhost');
    expect(msg!.sender).toBe('@bot:localhost');
    expect(msg!.status).toBe('streaming');

    const events = listEventsByMessage(msg!.id);
    const statusEvent = events.find((e) => e.eventType === 'status_change');
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.payload.status).toBe('streaming');
  });

  it('thinking / text / todo_update chunk 追加对应 events（payload 正确）', () => {
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-map-2',
      sessionId: '!room:localhost',
      senderAgentId: '@bot:localhost',
    });
    const parent = getMessageByStreamSessionId('ss-map-2')!;

    __routeChunkToBufferForTest({ type: 'thinking', streamSessionId: 'ss-map-2', delta: '思考中' });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-map-2', delta: '正文' });
    __routeChunkToBufferForTest({
      type: 'todo_update',
      streamSessionId: 'ss-map-2',
      sessionId: '!room:localhost',
      todos: [{ id: 't1', subject: '任务A', status: 'in_progress' }],
    });
    __flushEventBufferForTest();

    const events = listEventsByMessage(parent.id);
    expect(events.find((e) => e.eventType === 'thinking_delta')!.payload.delta).toBe('思考中');
    expect(events.find((e) => e.eventType === 'text_delta')!.payload.delta).toBe('正文');
    const todoEvent = events.find((e) => e.eventType === 'todo_update');
    expect(todoEvent).toBeDefined();
    expect(todoEvent!.payload.todos).toEqual([
      { id: 't1', subject: '任务A', status: 'in_progress' },
    ]);
  });

  it('tool_call / tool_result chunk 按 callId 配对（tool_call_start / tool_call_result）', () => {
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-map-3',
      sessionId: '!room:localhost',
      senderAgentId: '@bot:localhost',
    });
    const parent = getMessageByStreamSessionId('ss-map-3')!;

    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: 'ss-map-3',
      callId: 'call-1',
      toolName: 'read_file',
      args: { path: 'a.ts' },
    });
    __routeChunkToBufferForTest({
      type: 'tool_result',
      streamSessionId: 'ss-map-3',
      callId: 'call-1',
      toolName: 'read_file',
      result: '内容',
      success: true,
    });
    __flushEventBufferForTest();

    const events = listEventsByMessage(parent.id);
    const start = events.find((e) => e.eventType === 'tool_call_start');
    expect(start).toBeDefined();
    expect(start!.payload.callId).toBe('call-1');
    expect(start!.payload.toolName).toBe('read_file');
    const result = events.find((e) => e.eventType === 'tool_call_result');
    expect(result).toBeDefined();
    expect(result!.payload.callId).toBe('call-1');
    expect(result!.payload.success).toBe(true);
  });

  it('end(stop) → messages.status=done + final event；end(interrupted) → aborted', () => {
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-map-4',
      sessionId: '!room:localhost',
      senderAgentId: '@bot:localhost',
    });
    const msg = getMessageByStreamSessionId('ss-map-4')!;

    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-map-4', finishReason: 'stop' });

    expect(getMessageByStreamSessionId('ss-map-4')!.status).toBe('done');
    const finalEvent = listEventsByMessage(msg.id).find((e) => e.eventType === 'final');
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.payload.status).toBe('done');

    __routeChunkToBufferForTest({
      type: 'end',
      streamSessionId: 'ss-map-4',
      finishReason: 'interrupted',
    });
    expect(getMessageByStreamSessionId('ss-map-4')!.status).toBe('aborted');
  });
});

// === segment_boundary 分段场景（自 runtime-segment.test.ts 平移） ===

describe('routeChunkToBuffer: segment_boundary 创建独立分段 message row', () => {
  beforeEach(() => {
    setupDb();
    __resetEventBufferForTest();
  });

  afterEach(() => {
    __resetEventBufferForTest();
    teardownDb();
  });

  it('segment_boundary chunk 在 messages 表插入独立分段 row（segment_of/segment_index 正确）', () => {
    // 1. 先发 start chunk 建父 message
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-1',
      sessionId: '!room:localhost',
      senderAgentId: '@bot:localhost',
    });
    const parent = getMessageByStreamSessionId('ss-1');
    expect(parent).not.toBeNull();
    expect(parent!.sender).toBe('@bot:localhost');

    // 2. 发 segment_boundary chunk（模拟 task_complete 第 1 段）
    __routeChunkToBufferForTest({
      type: 'segment_boundary',
      streamSessionId: 'ss-1',
      segmentIndex: 1,
      segmentBody: '第一段内容',
      segmentStreamSessionId: 'ss-1#seg1',
    });
    __flushEventBufferForTest();

    // 3. messages 表应有 2 行（父 + 分段）
    const rows = listMessagesBySession('!room:localhost');
    expect(rows).toHaveLength(2);

    // 4. 分段 row 字段正确
    const seg = getMessageByStreamSessionId('ss-1#seg1');
    expect(seg).not.toBeNull();
    expect(seg!.segmentOf).toBe('ss-1');
    expect(seg!.segmentIndex).toBe(1);
    expect(seg!.body).toBe('第一段内容');
    expect(seg!.status).toBe('done');
    expect(seg!.sender).toBe('@bot:localhost');
    expect(seg!.sessionId).toBe('!room:localhost');
  });

  it('多段分段：每段一条独立 row，segment_index 递增', () => {
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-2',
      sessionId: '!room:localhost',
      senderAgentId: '@bot:localhost',
    });

    // 第 1 段
    __routeChunkToBufferForTest({
      type: 'segment_boundary',
      streamSessionId: 'ss-2',
      segmentIndex: 1,
      segmentBody: '段一',
      segmentStreamSessionId: 'ss-2#seg1',
    });
    // 第 2 段
    __routeChunkToBufferForTest({
      type: 'segment_boundary',
      streamSessionId: 'ss-2',
      segmentIndex: 2,
      segmentBody: '段二',
      segmentStreamSessionId: 'ss-2#seg2',
    });
    __flushEventBufferForTest();

    const rows = listMessagesBySession('!room:localhost');
    // 父 + 2 段 = 3 行
    expect(rows).toHaveLength(3);

    const seg1 = getMessageByStreamSessionId('ss-2#seg1');
    expect(seg1!.segmentIndex).toBe(1);
    expect(seg1!.segmentOf).toBe('ss-2');
    const seg2 = getMessageByStreamSessionId('ss-2#seg2');
    expect(seg2!.segmentIndex).toBe(2);
    expect(seg2!.segmentOf).toBe('ss-2');
  });

  it('父 message 不存在时静默跳过（不抛错）', () => {
    // 不发 start chunk，直接发 segment_boundary —— 父 message 不存在
    __routeChunkToBufferForTest({
      type: 'segment_boundary',
      streamSessionId: 'ss-orphan',
      segmentIndex: 1,
      segmentBody: '孤儿段',
      segmentStreamSessionId: 'ss-orphan#seg1',
    });
    __flushEventBufferForTest();

    // 不应插入任何 row
    const rows = listMessagesBySession('!room:localhost');
    expect(rows).toHaveLength(0);
  });

  it('分段 row 关联一条 final event（携带 body）', () => {
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-3',
      sessionId: '!room:localhost',
      senderAgentId: '@bot:localhost',
    });
    __routeChunkToBufferForTest({
      type: 'segment_boundary',
      streamSessionId: 'ss-3',
      segmentIndex: 1,
      segmentBody: '段内容',
      segmentStreamSessionId: 'ss-3#seg1',
    });
    __flushEventBufferForTest();

    const seg = getMessageByStreamSessionId('ss-3#seg1');
    const events = listEventsByMessage(seg!.id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const finalEvent = events.find((e) => e.eventType === 'final');
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.payload.body).toBe('段内容');
  });

  it('segment_boundary 后父 message 的后续 events 仍关联父（路由不切换）', () => {
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-4',
      sessionId: '!room:localhost',
      senderAgentId: '@bot:localhost',
    });
    // 分段
    __routeChunkToBufferForTest({
      type: 'segment_boundary',
      streamSessionId: 'ss-4',
      segmentIndex: 1,
      segmentBody: '段一',
      segmentStreamSessionId: 'ss-4#seg1',
    });
    // 分段后的 text chunk 仍用父 streamSessionId —— 应关联父 message
    __routeChunkToBufferForTest({
      type: 'text',
      streamSessionId: 'ss-4',
      delta: '继续输出',
    });
    __flushEventBufferForTest();

    const parent = getMessageByStreamSessionId('ss-4')!;
    const parentEvents = listEventsByMessage(parent.id);
    // status_change + text_delta（分段后的 text 关联父）
    const textEvent = parentEvents.find((e) => e.eventType === 'text_delta');
    expect(textEvent).toBeDefined();
    expect(textEvent!.payload.delta).toBe('继续输出');
  });
});

// === abortStreamBySessionId：注册反转（setAbortResolver） ===

describe('abortStreamBySessionId', () => {
  afterEach(() => {
    // 恢复未注入状态，避免污染其他用例
    setAbortResolver(null);
  });

  it('注入 resolver 后转发 streamSessionId 并返回 resolver 结果', () => {
    const resolver = vi.fn((id: string) => id === 'ss-live');
    setAbortResolver(resolver);

    expect(abortStreamBySessionId('ss-live')).toBe(true);
    expect(abortStreamBySessionId('ss-gone')).toBe(false);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenNthCalledWith(1, 'ss-live');
    expect(resolver).toHaveBeenNthCalledWith(2, 'ss-gone');
  });

  it('未注入 resolver 时返回 false 不抛错', () => {
    expect(() => abortStreamBySessionId('ss-any')).not.toThrow();
    expect(abortStreamBySessionId('ss-any')).toBe(false);
  });

  it('重复注入覆盖旧 resolver（后注册者生效）', () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => false);
    setAbortResolver(first);
    setAbortResolver(second);

    expect(abortStreamBySessionId('ss-x')).toBe(false);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('ss-x');
  });
});
