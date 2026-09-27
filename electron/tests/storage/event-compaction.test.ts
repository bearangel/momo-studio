// electron/tests/storage/event-compaction.test.ts
//
// 事件压缩快照契约（2026-09-25 历史消息显示一致性 C 方案）：
//   1. 聚合等价性（铁律）：对同一事件集，renderer aggregateEvents(全量) 与
//      aggregateEvents(压缩) 在渲染消费字段上逐项相等——压缩是渲染信息的
//      严格保序无损变换，聚合器单一真相源不漂移
//   2. 游程合并语义：连续同类 delta 合一、交错保留、结构事件原样
//   3. 快照落库/读取/回填幂等（真实 SQLite）
//   4. 错误路径：损坏 events_json 行按无快照处理、回填自愈
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';
import { insertEventBatch, type MessageEventRow } from '../../src/main/storage/messages/events-repo';
import {
  compactEventDeltas,
  writeCompactSnapshot,
  getCompactSnapshots,
  backfillCompactSnapshots,
} from '../../src/main/storage/messages/event-compaction';
import { aggregateEvents } from '../../../renderer/src/lib/stream-aggregator';

const tmpRoot = path.join(os.tmpdir(), `ap-compact-${Date.now()}`);

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

function ev(
  messageId: string,
  seq: number,
  eventType: MessageEventRow['eventType'],
  payload: Record<string, unknown>,
): Omit<MessageEventRow, 'id' | 'createdAt'> {
  return { messageId, seq, eventType, payload };
}

/** 为 fixture messageId 建真实消息行（message_events 外键约束要求） */
function seedMessage(id: string): void {
  insertMessage({
    sessionId: 's-fx', sender: '@bot:home', eventType: 'm.room.message',
    body: 'x', streamSessionId: `ss-${id}`, status: 'done', id,
  });
}

/** 交错 fixture：think → text → 3 工具卡 → think → text → final（真实执行流形态） */
function interleavedFixture(messageId: string): MessageEventRow[] {
  const rows = [
    ev(messageId, 0, 'thinking_delta', { delta: '先分析需求' }),
    ev(messageId, 1, 'thinking_delta', { delta: '再定方案' }),
    ev(messageId, 2, 'text_delta', { delta: '我先探索工作区' }),
    ev(messageId, 3, 'text_delta', { delta: '确认代码基线。' }),
    ev(messageId, 4, 'tool_call_start', { callId: 'c1', toolName: 'list_files', args: { path: '.' } }),
    ev(messageId, 5, 'tool_call_result', { callId: 'c1', result: 'a.ts', success: true }),
    ev(messageId, 6, 'text_delta', { delta: '看到入口文件，' }),
    ev(messageId, 7, 'text_delta', { delta: '接着读配置。' }),
    ev(messageId, 8, 'thinking_delta', { delta: '配置符合预期' }),
    ev(messageId, 9, 'tool_call_start', { callId: 'c2', toolName: 'bash', args: { cmd: 'ls' } }),
    ev(messageId, 10, 'tool_call_result', { callId: 'c2', result: 'ok', success: true }),
    ev(messageId, 11, 'text_delta', { delta: '完成。' }),
    ev(messageId, 12, 'final', { status: 'done' }),
  ];
  return insertEventBatch(rows) as MessageEventRow[];
}

describe('compactEventDeltas — 游程合并语义', () => {
  it('连续同类 delta 合一；交错顺序保留；结构事件原样', () => {
    seedMessage('m-merge');
    const events = interleavedFixture('m-merge');
    const compacted = compactEventDeltas(events);

    // 13 行 → 2 thinking + 3 text 游程 + 5 结构 = 10 行
    expect(compacted).toHaveLength(10);
    // 游程锚定首行 seq（0/2/6/8/11）
    expect(compacted.map((e) => [e.seq, e.eventType])).toEqual([
      [0, 'thinking_delta'],
      [2, 'text_delta'],
      [4, 'tool_call_start'],
      [5, 'tool_call_result'],
      [6, 'text_delta'],
      [8, 'thinking_delta'],
      [9, 'tool_call_start'],
      [10, 'tool_call_result'],
      [11, 'text_delta'],
      [12, 'final'],
    ]);
    // delta 全文拼接
    expect(compacted[0]!.payload.delta).toBe('先分析需求再定方案');
    expect(compacted[1]!.payload.delta).toBe('我先探索工作区确认代码基线。');
    // 不改动入参（纯函数）
    expect(events).toHaveLength(13);
    expect(events[1]!.payload.delta).toBe('再定方案');
  });

  it('空数组与非字符串 delta 透传（错误路径）', () => {
    expect(compactEventDeltas([])).toEqual([]);
    const odd = [
      { id: 'e1', messageId: 'm', seq: 0, eventType: 'text_delta' as const, payload: { delta: 42 }, createdAt: 0 },
      { id: 'e2', messageId: 'm', seq: 1, eventType: 'text_delta' as const, payload: { delta: 'x' }, createdAt: 0 },
    ];
    const out = compactEventDeltas(odd);
    // 非字符串 delta 不并入游程（aggregateEvents 跳过它——等价性前提）
    expect(out[0]!.payload.delta).toBe(42);
    expect(out[1]!.payload.delta).toBe('x');
  });
});

describe('聚合等价契约（渲染消费字段）', () => {
  it('aggregateEvents(全量) ≡ aggregateEvents(压缩) —— thinking/text/segments/toolCalls/status 逐项相等', () => {
    seedMessage('m-equiv');
    const events = interleavedFixture('m-equiv');
    const full = aggregateEvents(events);
    const compacted = compactEventDeltas(events);
    const fromCompacted = aggregateEvents(compacted);

    expect(fromCompacted.thinking).toBe(full.thinking);
    expect(fromCompacted.text).toBe(full.text);
    expect(fromCompacted.status).toBe(full.status);
    expect(fromCompacted.error).toBe(full.error);
    // 交错时间线（segments 是 UI 线性渲染数据源）——顺序保真是本方案的立身之本
    expect(fromCompacted.segments).toEqual(full.segments);
    expect(fromCompacted.toolCalls).toEqual(full.toolCalls);
    expect(fromCompacted.dispatches).toEqual(full.dispatches);
    expect(fromCompacted.todos).toEqual(full.todos);
  });

  it('巨型消息形态（千级 thinking 游程）等价不衰减', () => {
    seedMessage('m-giant');
    const rows = [
      ...Array.from({ length: 900 }, (_, i) => ev('m-giant', i, 'thinking_delta', { delta: `思${i};` })),
      ev('m-giant', 900, 'text_delta', { delta: '结论' }),
      ev('m-giant', 901, 'final', { status: 'done' }),
    ];
    const events = insertEventBatch(rows) as MessageEventRow[];
    const compacted = compactEventDeltas(events);
    expect(compacted).toHaveLength(3); // 902 → 3
    const full = aggregateEvents(events);
    const fromCompacted = aggregateEvents(compacted);
    expect(fromCompacted.segments).toEqual(full.segments);
    expect(fromCompacted.thinking).toBe(full.thinking);
  });
});

describe('快照落库 / 读取 / 回填（真实 SQLite）', () => {
  it('writeCompactSnapshot → getCompactSnapshots 幂等往返', () => {
    insertMessage({
      sessionId: 's1', sender: '@bot:home', eventType: 'm.room.message',
      body: 'x', streamSessionId: 'ss-1', status: 'done',
    });
    const msgs = getDb().prepare('SELECT id FROM messages').all() as Array<{ id: string }>;
    const msgId = msgs[0]!.id;
    interleavedFixture(msgId);

    writeCompactSnapshot(msgId);
    const first = getCompactSnapshots([msgId]);
    expect(first.get(msgId)).toHaveLength(10);
    // 再写一次（终态钩子重复调用）——值不变
    writeCompactSnapshot(msgId);
    expect(getCompactSnapshots([msgId]).get(msgId)).toEqual(first.get(msgId));
  });

  it('backfillCompactSnapshots：缺失回填落库、已有直读、零事件消息安全', () => {
    const m1 = insertMessage({
      sessionId: 's2', sender: '@bot:home', eventType: 'm.room.message',
      body: 'a', streamSessionId: 'ss-a', status: 'done',
    });
    const m2 = insertMessage({
      sessionId: 's2', sender: '@bot:home', eventType: 'm.room.message',
      body: 'b', streamSessionId: 'ss-b', status: 'done',
    });
    interleavedFixture(m1.id);
    writeCompactSnapshot(m1.id); // m1 已有快照，m2 无事件无快照

    const got = backfillCompactSnapshots([m1.id, m2.id]);
    expect(got.get(m1.id)).toHaveLength(10); // 直读既有
    expect(got.get(m2.id)).toEqual([]); // 零事件消息回填空快照（不崩、不重复劳动）
    // m2 已落库（第二次调用走纯读路径）
    expect(getCompactSnapshots([m2.id]).get(m2.id)).toEqual([]);
  });

  it('损坏 events_json 行按无快照处理（错误路径），回填自愈重写', () => {
    const m = insertMessage({
      sessionId: 's3', sender: '@bot:home', eventType: 'm.room.message',
      body: 'c', streamSessionId: 'ss-c', status: 'done',
    });
    interleavedFixture(m.id);
    getDb()
      .prepare(`INSERT INTO message_compact_events (message_id, events_json, created_at) VALUES (?, ?, ?)`)
      .run(m.id, '{corrupted', Date.now());

    const snap = getCompactSnapshots([m.id]);
    expect(snap.has(m.id)).toBe(false);
    const healed = backfillCompactSnapshots([m.id]);
    expect(healed.get(m.id)).toHaveLength(10); // 回填重写自愈
  });
});

describe('backfillCompactSnapshots 流式守卫（2026-09-26 P0：流中快照截断）', () => {
  it('streaming 消息：不回填不落库（终态化由 finalize 钩子负责）', () => {
    const live = insertMessage({
      sessionId: 's-guard', sender: '@bot:home', eventType: 'm.room.message',
      body: '', streamSessionId: 'ss-guard', status: 'streaming',
    });
    insertEventBatch([
      ev(live.id, 0, 'thinking_delta', { delta: '思考中' }),
      ev(live.id, 1, 'text_delta', { delta: '正文' }),
    ]);
    const out = backfillCompactSnapshots([live.id]);
    expect(out.has(live.id)).toBe(false);
    const n = getDb()
      .prepare('SELECT COUNT(*) AS n FROM message_compact_events WHERE message_id = ?')
      .get(live.id) as { n: number };
    expect(n.n).toBe(0);
  });

  it('陈旧快照自愈：流中写入的截断快照在终态化后被重算刷新', () => {
    const m = insertMessage({
      sessionId: 's-guard', sender: '@bot:home', eventType: 'm.room.message',
      body: '', streamSessionId: 'ss-stale', status: 'streaming',
    });
    // 流中回填形态的历史中毒行：只有开头 2 条事件的截断快照
    getDb()
      .prepare('INSERT INTO message_compact_events (message_id, events_json, created_at) VALUES (?, ?, ?)')
      .run(m.id, JSON.stringify([ev(m.id, 0, 'thinking_delta', { delta: '开头思考' })]), 1000);
    // 流继续推进（DB 里已有完整事件）+ 终态化（updated_at 晚于快照 created_at）
    insertEventBatch([
      ev(m.id, 0, 'thinking_delta', { delta: '开头思考' }),
      ev(m.id, 1, 'text_delta', { delta: 'a' }),
      ev(m.id, 2, 'tool_call_start', { callId: 'c9', toolName: 'bash', args: {} }),
      ev(m.id, 3, 'tool_call_result', { callId: 'c9', result: 'ok', success: true }),
      ev(m.id, 4, 'final', { status: 'done' }),
    ]);
    getDb().prepare('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?').run('done', 5000, m.id);
    const out = backfillCompactSnapshots([m.id]);
    // 重算刷新：工具卡在场（中毒行的 1 事件版本被覆盖）
    expect(out.get(m.id)?.some((e) => e.eventType === 'tool_call_start')).toBe(true);
    const row = getDb()
      .prepare('SELECT events_json FROM message_compact_events WHERE message_id = ?')
      .get(m.id) as { events_json: string };
    expect(JSON.parse(row.events_json).some((e: { eventType: string }) => e.eventType === 'tool_call_start')).toBe(true);
  });

  it('终态消息：照常回填（守卫不误伤既有自愈语义）', () => {
    const done = insertMessage({
      sessionId: 's-guard', sender: '@bot:home', eventType: 'm.room.message',
      body: 'x', streamSessionId: 'ss-guard-2', status: 'done',
    });
    insertEventBatch([
      ev(done.id, 0, 'text_delta', { delta: 'a' }),
      ev(done.id, 1, 'text_delta', { delta: 'b' }),
      ev(done.id, 2, 'final', { status: 'done' }),
    ]);
    const out = backfillCompactSnapshots([done.id]);
    expect(out.get(done.id)?.map((e) => e.eventType)).toEqual(['text_delta', 'final']);
  });
});
