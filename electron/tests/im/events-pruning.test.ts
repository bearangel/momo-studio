// electron/tests/im/events-pruning.test.ts
//
// session:getMessages 事件裁剪契约（工作空间切换卡顿修复 + C 方案压缩快照，
// 2026-09-25）：
// 根因——withEvents 对全部（≤1000 条）消息逐条拉全量事件（流式逐 token 落一行，
// 重会话 45 万事件）+ 每行 JSON.parse + 全量 IPC clone → 主进程事件循环阻塞 1-3s。
//
// 新契约（eventsByMessage 裁剪规则，两端同改——boundary-rules）：
//   1. 最近 fullRecentCount（缺省 30）条消息：全量事件（流式候选 + 即时上下文）
//   2. 单消息事件数 > perMessageCap（缺省 2000）或更早消息：压缩快照
//      （终态游程合并——连续 thinking/text delta 合一、结构事件保留；
//      交错顺序保真，thinking/正文/工具卡全量在场）
//   3. 零事件消息：key 省略（renderer 静态气泡渲染 body）
//
// 本文件对真实 SQLite 锁契约，并用 renderer aggregateEvents 做端到端消费断言
//（压缩事件的聚合等价性由 tests/storage/event-compaction.test.ts 契约锁覆盖）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertMessage,
  listMessagesBySession,
} from '../../src/main/storage/messages/repo';
import { insertEventBatch } from '../../src/main/storage/messages/events-repo';
import { buildEventsByMessage } from '../../src/main/im/events-pruning';
import { getCompactSnapshots } from '../../src/main/storage/messages/event-compaction';
import { aggregateEvents } from '../../../renderer/src/lib/stream-aggregator';
import type { MessageEventRow } from '../../src/main/storage/messages/events-repo';

const tmpRoot = path.join(os.tmpdir(), `ap-pruning-${Date.now()}`);

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

/** 确定性时间戳：插入后显式 UPDATE created_at（insertMessage 用 Date.now()，
 *  同毫秒插入会让「最近 K 条」窗口判定不稳定） */
function backdateCreated(msgId: string, createdAt: number): void {
  getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(createdAt, msgId);
}

function ev(messageId: string, seq: number, eventType: MessageEventRow['eventType'], payload: Record<string, unknown>): Omit<MessageEventRow, 'id' | 'createdAt'> {
  return { messageId, seq, eventType, payload };
}

describe('buildEventsByMessage — 事件裁剪契约（压缩快照）', () => {
  it('最近窗口小消息全量；更早/巨型消息压缩快照（thinking/正文/工具全量保序）；零事件消息省略 key', async () => {
    // 旧消息：thinking + text 增量 + 工具调用 + final（交错执行流形态）
    const old = insertMessage({
      sessionId: 's1', sender: '@bot:home', eventType: 'm.room.message',
      body: '旧消息正文全文', streamSessionId: 'ss-old', status: 'done',
    });
    backdateCreated(old.id, 1000);
    insertEventBatch([
      ev(old.id, 0, 'thinking_delta', { delta: '思考' }),
      ev(old.id, 1, 'text_delta', { delta: '旧消息' }),
      ev(old.id, 2, 'text_delta', { delta: '正文全文' }),
      ev(old.id, 3, 'tool_call_start', { callId: 'c1', toolName: 'bash', args: { cmd: 'ls' } }),
      ev(old.id, 4, 'tool_call_result', { callId: 'c1', result: 'a.txt', success: true }),
      ev(old.id, 5, 'final', { status: 'done' }),
    ]);

    // 巨型消息：52 delta（> 注入 cap=50），带 thinking——走压缩快照
    const giant = insertMessage({
      sessionId: 's1', sender: '@bot:home', eventType: 'm.room.message',
      body: '巨型消息正文', streamSessionId: 'ss-giant', status: 'done',
    });
    backdateCreated(giant.id, 2000);
    insertEventBatch([
      ev(giant.id, 0, 'thinking_delta', { delta: '巨型思考' }),
      ...Array.from({ length: 51 }, (_, i) => ev(giant.id, i + 1, 'text_delta', { delta: `块${i}` })),
      ev(giant.id, 52, 'final', { status: 'done' }),
    ]);

    // 最近消息：小体量，应拿全量
    const recent = insertMessage({
      sessionId: 's1', sender: '@bot:home', eventType: 'm.room.message',
      body: '最近消息', streamSessionId: 'ss-recent', status: 'done',
    });
    backdateCreated(recent.id, 3000);
    insertEventBatch([
      ev(recent.id, 0, 'text_delta', { delta: '最' }),
      ev(recent.id, 1, 'text_delta', { delta: '近消息' }),
      ev(recent.id, 2, 'final', { status: 'done' }),
    ]);

    // 零事件消息：key 省略
    const empty = insertMessage({
      sessionId: 's1', sender: 'owner', eventType: 'm.room.message',
      body: '纯文本', streamSessionId: null, status: 'done',
    });
    backdateCreated(empty.id, 500);

    const messages = listMessagesBySession('s1');
    expect(messages.map((m) => m.id)).toEqual([empty.id, old.id, giant.id, recent.id]);

    // fullRecentCount=1（仅最后一条全量）+ perMessageCap=50（giant 53 事件走快照）
    const eventsByMessage = await buildEventsByMessage(messages, { fullRecentCount: 1, perMessageCap: 50 });

    // 1) 最近小消息：全量（delta 原样）
    const recentEvents = eventsByMessage[recent.id] ?? [];
    expect(recentEvents.map((e) => e.eventType)).toEqual(['text_delta', 'text_delta', 'final']);

    // 2) 更早消息：压缩快照——thinking/正文/工具/final 全量在场且保序
    const oldEvents = eventsByMessage[old.id] ?? [];
    expect(oldEvents.map((e) => e.eventType)).toEqual([
      'thinking_delta', 'text_delta', 'tool_call_start', 'tool_call_result', 'final',
    ]);
    expect(oldEvents[1]!.payload.delta).toBe('旧消息正文全文'); // 连续 text 游程合一

    // 3) 巨型消息（最近窗口判定内但超 cap）：压缩快照（53 → 3）
    const giantEvents = eventsByMessage[giant.id] ?? [];
    expect(giantEvents.map((e) => e.eventType)).toEqual(['thinking_delta', 'text_delta', 'final']);
    expect(giantEvents[0]!.payload.delta).toBe('巨型思考');
    expect(giantEvents[1]!.payload.delta).toBe(
      Array.from({ length: 51 }, (_, i) => `块${i}`).join(''),
    );

    // 4) 零事件消息：key 省略
    expect(eventsByMessage[empty.id]).toBeUndefined();

    // 5) 端到端消费：压缩事件 → 交错时间线完整还原（不依赖 body 回退）
    const agg = aggregateEvents(oldEvents);
    expect(agg.status).toBe('done');
    expect(agg.thinking).toBe('思考');
    expect(agg.text).toBe('旧消息正文全文');
    expect(agg.toolCalls).toHaveLength(1);
    expect(agg.toolCalls[0]?.result).toBe('a.txt');
    // 交错顺序：thinking → text → tool（与流式时一致）
    expect(agg.segments.map((s) => s.kind)).toEqual(['thinking', 'text', 'tool_call']);

    // 6) 快照已落库（第二次调用走直读）
    expect(getCompactSnapshots([old.id, giant.id]).get(old.id)).toEqual(oldEvents);
  });

  it('fullRecentCount=0（loadOlder 语义）：全部消息走压缩快照', async () => {
    const m1 = insertMessage({
      sessionId: 's2', sender: '@bot:home', eventType: 'm.room.message',
      body: '历史', streamSessionId: 'ss-1', status: 'done',
    });
    insertEventBatch([
      ev(m1.id, 0, 'text_delta', { delta: '历' }),
      ev(m1.id, 1, 'text_delta', { delta: '史' }),
      ev(m1.id, 2, 'final', { status: 'done' }),
    ]);

    const eventsByMessage = await buildEventsByMessage(listMessagesBySession('s2'), { fullRecentCount: 0 });
    // 压缩快照：text 游程合一
    expect(eventsByMessage[m1.id]?.map((e) => e.eventType)).toEqual(['text_delta', 'final']);
    expect(eventsByMessage[m1.id]?.[0]?.payload.delta).toBe('历史');
  });

  it('空消息列表 → 空对象（防炸）', async () => {
    expect(await buildEventsByMessage([])).toEqual({});
  });

  it('消息事件数恰等于 cap：不降级（边界含）', async () => {
    const m = insertMessage({
      sessionId: 's3', sender: '@bot:home', eventType: 'm.room.message',
      body: 'x', streamSessionId: 'ss-3', status: 'done',
    });
    insertEventBatch([
      ...Array.from({ length: 50 }, (_, i) => ev(m.id, i, 'text_delta', { delta: 'x' })),
      ev(m.id, 50, 'final', { status: 'done' }),
    ]);
    // 51 事件 > cap=50 走快照；改 cap=51 恰好不降级（全量——delta 原样多条）
    const eventsByMessage = await buildEventsByMessage(listMessagesBySession('s3'), { fullRecentCount: 1, perMessageCap: 51 });
    expect(eventsByMessage[m.id]).toHaveLength(51);
  });
});

describe('流式巨消息不降级（2026-09-26 任务框丢失 P0）', () => {
  it('status=streaming 且超 cap → 全量事件直供 + 不落压缩快照（流中快照会把工具卡截死）', async () => {
    const live = insertMessage({
      sessionId: 's4', sender: '@bot:home', eventType: 'm.room.message',
      body: '', streamSessionId: 'ss-live', status: 'streaming',
    });
    const liveEvents = [
      ev(live.id, 0, 'thinking_delta', { delta: '思考' }),
      ...Array.from({ length: 60 }, (_, i) => ev(live.id, i + 1, 'text_delta', { delta: `t${i}` })),
      ev(live.id, 61, 'tool_call_start', { callId: 'c1', toolName: 'bash', args: { cmd: 'ls' } }),
      ev(live.id, 62, 'tool_call_result', { callId: 'c1', result: 'ok', success: true }),
    ];
    insertEventBatch(liveEvents);

    const eventsByMessage = await buildEventsByMessage(listMessagesBySession('s4'), {
      fullRecentCount: 5,
      perMessageCap: 50,
    });

    // 全量直供：原始条数、无游程合并（63 条原样）
    expect(eventsByMessage[live.id]).toHaveLength(63);
    expect(eventsByMessage[live.id]?.filter((e) => e.eventType.startsWith('tool'))).toHaveLength(2);
    // 不为流式消息落快照——终态化由 finalize 钩子补写完整版
    expect(getCompactSnapshots([live.id]).has(live.id)).toBe(false);
  });

  it('同一消息终态化后（status=done）→ 恢复压缩快照降级（原语义回归保护）', async () => {
    const done = insertMessage({
      sessionId: 's5', sender: '@bot:home', eventType: 'm.room.message',
      body: '终态巨消息', streamSessionId: 'ss-done', status: 'done',
    });
    insertEventBatch([
      ev(done.id, 0, 'thinking_delta', { delta: '思考' }),
      ...Array.from({ length: 60 }, (_, i) => ev(done.id, i + 1, 'text_delta', { delta: `t${i}` })),
      ev(done.id, 61, 'final', { status: 'done' }),
    ]);
    const eventsByMessage = await buildEventsByMessage(listMessagesBySession('s5'), {
      fullRecentCount: 5,
      perMessageCap: 50,
    });
    // 压缩快照：text 游程合一（63 → 3）
    expect(eventsByMessage[done.id]?.map((e) => e.eventType)).toEqual(['thinking_delta', 'text_delta', 'final']);
  });
});
