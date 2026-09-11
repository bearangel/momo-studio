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

// mock electron：BrowserWindow.getAllWindows 返回可控假窗口。
// 回归锁（2.0.0 主机验收 P0-2）：start/segment_boundary INSERT 消息行后必须推
// session:message 给 renderer——否则 agent 流式气泡实时永远不出现，重启才可见。
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import {
  __routeChunkToBufferForTest,
  __resetEventBufferForTest,
  __flushEventBufferForTest,
  setAbortResolver,
  abortStreamBySessionId,
  finalizeStreamOnCrash,
} from '../../src/main/agent/stream-relay';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import {
  insertMessage,
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

  it('regression：start chunk INSERT 后推 session:message 给 renderer（实时气泡可见性）', () => {
    mockSend.mockClear();
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-push-1',
      sessionId: '!room:localhost',
      senderAgentId: '@bot:localhost',
    });

    const msg = getMessageByStreamSessionId('ss-push-1');
    expect(msg).not.toBeNull();
    expect(mockSend).toHaveBeenCalledWith('session:message', expect.objectContaining({ id: msg!.id, status: 'streaming' }));
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
      todos: [{ id: 't1', subject: '任务A', status: 'in_progress', source: 'agent' }],
    });
    __flushEventBufferForTest();

    const events = listEventsByMessage(parent.id);
    expect(events.find((e) => e.eventType === 'thinking_delta')!.payload.delta).toBe('思考中');
    expect(events.find((e) => e.eventType === 'text_delta')!.payload.delta).toBe('正文');
    const todoEvent = events.find((e) => e.eventType === 'todo_update');
    expect(todoEvent).toBeDefined();
    expect(todoEvent!.payload.todos).toEqual([
      { id: 't1', subject: '任务A', status: 'in_progress', source: 'agent' },
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

  it('minor-3 回归锁：end(budget_exhausted) → status=failed 且 final 事件携带中文错误文案', () => {
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-budget-1',
      sessionId: '!room:localhost',
      senderAgentId: '@bot:localhost',
    });
    const msg = getMessageByStreamSessionId('ss-budget-1')!;

    // runtime-entry 发 budget_exhausted 时不带 error 字段——文案由 relay 补齐
    __routeChunkToBufferForTest({
      type: 'end',
      streamSessionId: 'ss-budget-1',
      finishReason: 'budget_exhausted',
    });

    expect(getMessageByStreamSessionId('ss-budget-1')!.status).toBe('failed');
    const finalEvent = listEventsByMessage(msg.id).find((e) => e.eventType === 'final');
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.payload.status).toBe('failed');
    expect(finalEvent!.payload.error).toBe('工具调用预算已耗尽');
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

    // 5. regression：分段 row 也推 session:message（实时分段堆叠可见性）
    expect(mockSend).toHaveBeenCalledWith('session:message', expect.objectContaining({ id: seg!.id, segmentOf: 'ss-1' }));
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

// === end 终态回写 body（复制/导出契约修复） ===
//
// 根因（2026-09-06 bug 双案）：routeChunkToBuffer 生命周期里 agent 消息 body
// 恒为 ''（start 插空、text 只进 events、end 不回写）。显示侧靠 events 聚合
// 正常，复制按钮 / 会话导出读 messages.body 双双踩空（粘贴空串 / 导出正文为空）。
// 契约：end / 崩溃收尾时聚合 text_delta 回写 body + 推送更新行给 renderer。

describe('end 终态回写 body + 推送更新行', () => {
  beforeEach(() => {
    setupDb();
    __resetEventBufferForTest();
    mockSend.mockClear();
  });

  afterEach(() => {
    __resetEventBufferForTest();
    teardownDb();
  });

  it('end(stop) 聚合全部 text_delta 回写 messages.body 并置 done', () => {
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-body-1', sessionId: 'r-body', senderAgentId: '@bot.x:home',
    });
    __routeChunkToBufferForTest({ type: 'thinking', streamSessionId: 'ss-body-1', delta: '内心独白' });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-body-1', delta: '你好' });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-body-1', delta: '，世界' });
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-body-1', finishReason: 'stop' });

    const row = getMessageByStreamSessionId('ss-body-1')!;
    expect(row.status).toBe('done');
    // thinking 不得混入正文；text_delta 按 seq 顺序拼接
    expect(row.body).toBe('你好，世界');
  });

  it('end 后推送 session:message 更新行（body 非空、同 id）——否则 renderer 停留旧行', () => {
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-body-2', sessionId: 'r-body', senderAgentId: '@bot.x:home',
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-body-2', delta: '最终回复' });
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-body-2', finishReason: 'stop' });

    const pushed = mockSend.mock.calls
      .filter((c) => c[0] === 'session:message')
      .map((c) => c[1] as { id: string; streamSessionId: string; body: string; status: string });
    const forThisStream = pushed.filter((p) => p.streamSessionId === 'ss-body-2');
    // start 落库推一次（body 空）+ end 更新推一次（body 已回写）
    expect(forThisStream.length).toBeGreaterThanOrEqual(2);
    const last = forThisStream[forThisStream.length - 1]!;
    expect(last.body).toBe('最终回复');
    expect(last.status).toBe('done');
  });

  it('end(interrupted) 中止流：已生成的部分文本回写 body、status=aborted', () => {
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-body-3', sessionId: 'r-body', senderAgentId: '@bot.x:home',
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-body-3', delta: '写到一半' });
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-body-3', finishReason: 'interrupted' });

    const row = getMessageByStreamSessionId('ss-body-3')!;
    expect(row.status).toBe('aborted');
    expect(row.body).toBe('写到一半');
  });

  it('纯 thinking 流（无 text_delta）：body 保持空串，不报错', () => {
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-body-4', sessionId: 'r-body', senderAgentId: '@bot.x:home',
    });
    __routeChunkToBufferForTest({ type: 'thinking', streamSessionId: 'ss-body-4', delta: '只思考' });
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-body-4', finishReason: 'stop' });

    const row = getMessageByStreamSessionId('ss-body-4')!;
    expect(row.status).toBe('done');
    expect(row.body).toBe('');
  });

  it('finalizeStreamOnCrash：已落盘 text_delta 回写 body 并置 failed', () => {
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-body-5', sessionId: 'r-body', senderAgentId: '@bot.x:home',
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-body-5', delta: '崩溃前文本' });
    // 崩溃前 pending 已落盘（真实链路里 flush 窗口先于 child exit）
    __flushEventBufferForTest();

    finalizeStreamOnCrash('ss-body-5', 1);

    const row = getMessageByStreamSessionId('ss-body-5')!;
    expect(row.status).toBe('failed');
    expect(row.body).toBe('崩溃前文本');
  });
});

// === start 幂等化（v2.6.0 final review C1：resume 复用 streamSessionId） ===
//
// 历史全部 randomUUID 新流，无条件 INSERT 不会撞 ssi；resume 是首个跨子进程
// 重启复用 ssi 的流程——旧实现每次恢复 INSERT 一条 status='streaming' body=''
// 的僵尸行（无 end 引用 → 下次 boot 被 sweepStaleStreaming 标 failed+final
// 「进程中断」→ 会话历史永久幽灵气泡）。红绿变异记录：摘掉幂等化（恢复为
// 无条件 INSERT）→ 「行数 1」断言必红（实际 2 行僵尸）。

describe('start 幂等化（同 ssi 二次 start 续流行，不 INSERT）', () => {
  beforeEach(() => {
    setupDb();
    __resetEventBufferForTest();
    mockSend.mockClear();
  });

  afterEach(() => {
    __resetEventBufferForTest();
    teardownDb();
  });

  it('同一 ssi 二次 start：行数不增、复用同一行、第二次 status_change 已落且 seq 递增', () => {
    // 第一次 start（resume 前该行已被 flip 翻回 streaming——flip 已有独立锁，
    // 此处直接以真实 start 建立同形态：streaming 行 + ssi）
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-idem-1',
      sessionId: '!room:idem',
      senderAgentId: '@bot:localhost',
    });
    __flushEventBufferForTest();
    const first = getMessageByStreamSessionId('ss-idem-1')!;
    expect(first.status).toBe('streaming');

    // 第二次 start：resume 派发后子进程重发（同 ssi）
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-idem-1',
      sessionId: '!room:idem',
      senderAgentId: '@bot:localhost',
    });
    __flushEventBufferForTest();

    // 行数不变（红绿点：旧实现 +1 僵尸行）+ 复用同一行 id
    const rows = listMessagesBySession('!room:idem');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.id);

    // 第二次 status_change 已落复用行：共 2 条，seq 严格递增（事件续接不重排）
    const statusChanges = listEventsByMessage(first.id).filter(
      (e) => e.eventType === 'status_change',
    );
    expect(statusChanges).toHaveLength(2);
    expect(statusChanges[0]!.seq).toBeLessThan(statusChanges[1]!.seq);
    expect(statusChanges.every((e) => e.payload.status === 'streaming')).toBe(true);

    // 复用行再次推给 renderer（幂等路径也走 pushSessionMessage——实时可见性）
    const pushed = mockSend.mock.calls
      .filter((c) => c[0] === 'session:message')
      .map((c) => (c[1] as { id: string }).id);
    expect(pushed.filter((id) => id === first.id).length).toBe(2);
  });

  it('幂等续流端到端：二次 start 后 text/end 落复用行收尾（单行 done，body 聚合）', () => {
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-idem-2', sessionId: '!room:idem', senderAgentId: '@bot:localhost',
    });
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-idem-2', sessionId: '!room:idem', senderAgentId: '@bot:localhost',
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-idem-2', delta: '续跑输出' });
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-idem-2', finishReason: 'stop' });

    const rows = listMessagesBySession('!room:idem');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('done');
    expect(rows[0]!.body).toBe('续跑输出');
  });

  it('带 roll 的流族：start 用 base ssi 复用最新 #roll1 行（base 保持 done 不动）', () => {
    // 真实生产路径建 roll 族：base 行 + roll 换行终态化 base + #roll1 承接
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-idem-r', sessionId: '!room:idem', senderAgentId: '@bot:localhost',
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-idem-r', delta: '断点前' });
    __routeChunkToBufferForTest({ type: 'message_roll', streamSessionId: 'ss-idem-r' });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-idem-r', delta: '滚后' });
    __flushEventBufferForTest();

    // resume 派发后子进程以 base ssi 重发 start → 必须续流 #roll1（族内当前行）
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-idem-r', sessionId: '!room:idem', senderAgentId: '@bot:localhost',
    });
    __flushEventBufferForTest();

    const rows = listMessagesBySession('!room:idem');
    expect(rows).toHaveLength(2); // base + #roll1，无新行
    const base = rows.find((m) => m.streamSessionId === 'ss-idem-r')!;
    const roll1 = rows.find((m) => m.streamSessionId === 'ss-idem-r#roll1')!;
    expect(base.status).toBe('done'); // 已被 roll 终态化——不被翻回
    expect(roll1.status).toBe('streaming'); // 当前行续流
    // #roll1 上共 2 条 status_change（roll 建行 + 幂等 start）
    const statusChanges = listEventsByMessage(roll1.id).filter(
      (e) => e.eventType === 'status_change',
    );
    expect(statusChanges).toHaveLength(2);
  });

  it('命中非 streaming 旧行（契约外形态）：warn 后按新流 INSERT 独立行，事件落新行', () => {
    // 真实路径造 done 旧行：start + end 收尾
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-idem-d', sessionId: '!room:idem', senderAgentId: '@bot:localhost',
    });
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-idem-d', finishReason: 'stop' });
    __flushEventBufferForTest();
    expect(getMessageByStreamSessionId('ss-idem-d')!.status).toBe('done');

    // 同 ssi 再 start（正常 resume 不应出现——flip 先行；防御路径锁行为）
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-idem-d', sessionId: '!room:idem', senderAgentId: '@bot:localhost',
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-idem-d', delta: '新流文本' });
    __flushEventBufferForTest();

    // warn 后按新流处理：done 旧行不动 + 新 streaming 行承接事件
    const rows = listMessagesBySession('!room:idem');
    expect(rows).toHaveLength(2);
    const doneRows = rows.filter((m) => m.status === 'done');
    const streamingRows = rows.filter((m) => m.status === 'streaming');
    expect(doneRows).toHaveLength(1);
    expect(streamingRows).toHaveLength(1);
    expect(
      listEventsByMessage(streamingRows[0]!.id).some(
        (e) => e.eventType === 'text_delta' && e.payload.delta === '新流文本',
      ),
    ).toBe(true);
  });

  it('未命中旧行：保持历史行为 INSERT 新行（首启动新流不受幂等化影响）', () => {
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-idem-fresh', sessionId: '!room:idem', senderAgentId: '@bot:localhost',
    });
    __flushEventBufferForTest();

    const rows = listMessagesBySession('!room:idem');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('streaming');
    expect(rows[0]!.sender).toBe('@bot:localhost');
  });
});
