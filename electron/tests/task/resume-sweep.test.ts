// electron/tests/task/resume-sweep.test.ts
//
// v2.6.0 boot 陈旧流清扫 sweepStaleStreaming（Task 3）行为锁：
//   - fixture 经真实生产路径 routeChunkToBuffer（start/text）写入——
//     App 崩溃时滞留 streaming 的行就这么来；不手搓生产不存在的形态
//     （momo-test-rules 教训：mock 必须仿真真实运行时语义）
//   - 形态照 finalizeStreamOnCrash（stream-relay.ts:174）：
//     updateMessageStatus('failed', aggregateTextDeltas) + final 事件
//     { status: 'failed', error: '进程中断' }
//   - 断言：streaming 行 → failed + body 聚合回写 + final 事件落库；
//     幂等（二次扫返回 0）；非 streaming 行零触碰（updatedAt 断言）；
//     空表与无 streaming 行返回 0 不抛错

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sweepStaleStreaming, STALE_STREAM_ERROR } from '../../src/main/task/resume';
import {
  __resetEventBufferForTest,
  __routeChunkToBufferForTest,
  __flushEventBufferForTest,
} from '../../src/main/agent/stream-relay';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import {
  insertMessage,
  getMessageByStreamSessionId,
} from '../../src/main/storage/messages/repo';
import { listEventsByMessage } from '../../src/main/storage/messages/events-repo';

const tmpRoot = path.join(os.tmpdir(), `ap-resume-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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

/**
 * 经真实生产路径写入 streaming 行 + 文本事件（不手插 production 不存在的
 * 形态）。App 崩溃时 buffer 已 flush，行 + events 同表真实态。
 */
function seedStreamingRow(ssId: string, deltas: string[]): void {
  __routeChunkToBufferForTest({
    type: 'start',
    streamSessionId: ssId,
    sessionId: 'sess-sweep',
    senderAgentId: 'agent-sweep',
  });
  for (const d of deltas) {
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: ssId, delta: d });
  }
  // App 崩溃前事件已全部落盘（boot 时无 pending——buffer 重启即空）
  __flushEventBufferForTest();
}

describe('sweepStaleStreaming（v2.6.0 boot 陈旧流清扫）', () => {
  beforeEach(() => {
    setupDb();
    __resetEventBufferForTest();
  });
  afterEach(() => {
    __resetEventBufferForTest();
    teardownDb();
  });

  it('streaming 行 → failed + body 聚合回写（aggregateTextDeltas）+ final 事件「进程中断」', () => {
    seedStreamingRow('ss-sweep-1', ['部分输出一', '部分输出二']);

    expect(getMessageByStreamSessionId('ss-sweep-1')!.status).toBe('streaming');

    const n = sweepStaleStreaming();
    expect(n).toBe(1);

    const msg = getMessageByStreamSessionId('ss-sweep-1')!;
    // 状态翻转（终态——与 finalizeStreamOnCrash 一致）
    expect(msg.status).toBe('failed');
    // 正文聚合回写（body 单一真相源——与 finalizeStreamOnCrash 同契约）
    expect(msg.body).toBe('部分输出一' + '部分输出二');
    // final 事件落库 + payload 形态对齐 stream-relay
    const events = listEventsByMessage(msg.id);
    const final = events.find((e) => e.eventType === 'final');
    expect(final).toBeDefined();
    expect(final!.payload).toEqual({ status: 'failed', error: '进程中断' });
    // STALE_STREAM_ERROR 导出常量与 final payload 一致（防止文档/实现漂移）
    expect(STALE_STREAM_ERROR).toBe('进程中断');
  });

  it('多 streaming 行一次性清扫（返回值 = 命中数）', () => {
    seedStreamingRow('ss-sweep-multi-a', []);
    seedStreamingRow('ss-sweep-multi-b', []);

    expect(sweepStaleStreaming()).toBe(2);
    expect(getMessageByStreamSessionId('ss-sweep-multi-a')!.status).toBe('failed');
    expect(getMessageByStreamSessionId('ss-sweep-multi-b')!.status).toBe('failed');
  });

  it('幂等：二次清扫返回 0（行已 failed 不再命中）', () => {
    seedStreamingRow('ss-sweep-idem', []);

    expect(sweepStaleStreaming()).toBe(1);
    expect(sweepStaleStreaming()).toBe(0);
  });

  it('非 streaming 行零触碰（updatedAt 不变，状态不变）', () => {
    // done / failed / aborted 各一行——已由正常路径收尾；本测试锁清扫不动它们
    insertMessage({
      sessionId: 'sess-sweep',
      sender: 'agent-sweep',
      eventType: 'm.room.message',
      body: 'done-body',
      streamSessionId: 'ss-sweep-done',
      status: 'done',
    });
    insertMessage({
      sessionId: 'sess-sweep',
      sender: 'agent-sweep',
      eventType: 'm.room.message',
      body: 'failed-body',
      streamSessionId: 'ss-sweep-failed',
      status: 'failed',
    });
    insertMessage({
      sessionId: 'sess-sweep',
      sender: 'agent-sweep',
      eventType: 'm.room.message',
      body: 'aborted-body',
      streamSessionId: 'ss-sweep-aborted',
      status: 'aborted',
    });

    expect(sweepStaleStreaming()).toBe(0);

    // 全部状态与正文保持不变（清扫对非 streaming 行零写）
    expect(getMessageByStreamSessionId('ss-sweep-done')!.status).toBe('done');
    expect(getMessageByStreamSessionId('ss-sweep-failed')!.status).toBe('failed');
    expect(getMessageByStreamSessionId('ss-sweep-aborted')!.status).toBe('aborted');
    expect(getMessageByStreamSessionId('ss-sweep-done')!.body).toBe('done-body');
    expect(getMessageByStreamSessionId('ss-sweep-failed')!.body).toBe('failed-body');
    expect(getMessageByStreamSessionId('ss-sweep-aborted')!.body).toBe('aborted-body');
  });

  it('空表 + 无 streaming 行：返回 0 不抛错（边界空输入，momo-test-rules 要求）', () => {
    expect(sweepStaleStreaming()).toBe(0);

    // 追加 done 行后再扫——仍 0，不动 done
    insertMessage({
      sessionId: 'sess-sweep',
      sender: 'agent-sweep',
      eventType: 'm.room.message',
      body: 'x',
      streamSessionId: 'ss-sweep-only-done',
      status: 'done',
    });
    expect(sweepStaleStreaming()).toBe(0);
  });
});