// electron/tests/agent/stream-relay-roll.test.ts
//
// message_roll handler（v2.3.1 spec §2.3）：旧行终态化 + 新行承接 + cache 换指向
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// mock electron：BrowserWindow.getAllWindows 返回可控假窗口。
// 回归锁（2.0.0 主机验收 P0-2）：roll handler 落盘后必须推 session:message 给 renderer——
// 否则新消息行实时不可见，重启才出现。
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import {
  routeChunkToBuffer,
  __resetEventBufferForTest,
  __flushEventBufferForTest,
  __rollCountsForTest,
} from '../../src/main/agent/stream-relay';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { listMessagesBySession } from '../../src/main/storage/messages/repo';

// === DB 测试夹具（照抄 stream-relay.test.ts 既有模式） ===

const tmpRoot = path.join(os.tmpdir(), `ap-roll-${Date.now()}`);

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

/** 快捷：start 一条流并产 N 个 text delta */
function seedStreamingSession(streamSessionId: string, texts: string[]): void {
  routeChunkToBuffer({ type: 'start', streamSessionId, sessionId: 's1', senderAgentId: 'agent-x' });
  for (const t of texts) {
    routeChunkToBuffer({ type: 'text', streamSessionId, delta: t });
  }
}

describe('routeChunkToBuffer message_roll', () => {
  beforeEach(() => {
    setupDb();
    __resetEventBufferForTest();
    __rollCountsForTest();
  });

  afterEach(() => {
    __resetEventBufferForTest();
    __rollCountsForTest();
    teardownDb();
  });

  it('roll：旧行 done + body 聚合回写，新行 streaming 插入且 streamSessionId 带 #roll1 后缀', () => {
    seedStreamingSession('ss-r', ['第一段', '内容']);
    routeChunkToBuffer({ type: 'message_roll', streamSessionId: 'ss-r' });
    __flushEventBufferForTest();

    const rows = listMessagesBySession('s1');
    const old = rows.find((m) => m.streamSessionId === 'ss-r')!;
    const next = rows.find((m) => m.streamSessionId === 'ss-r#roll1')!;
    expect(old.status).toBe('done');
    expect(old.body).toBe('第一段内容');          // text_delta 聚合回写
    expect(next.status).toBe('streaming');
    expect(next.segmentOf).toBeNull();            // 不是 segment 行——正常渲染
  });

  it('roll 后 text/end 落新行；end 时新行 body 聚合、旧行不动', () => {
    seedStreamingSession('ss-r', ['旧']);
    routeChunkToBuffer({ type: 'message_roll', streamSessionId: 'ss-r' });
    routeChunkToBuffer({ type: 'text', streamSessionId: 'ss-r', delta: '新行文本' });
    routeChunkToBuffer({ type: 'end', streamSessionId: 'ss-r', finishReason: 'stop' });
    __flushEventBufferForTest();

    const rows = listMessagesBySession('s1');
    const old = rows.find((m) => m.streamSessionId === 'ss-r')!;
    const next = rows.find((m) => m.streamSessionId === 'ss-r#roll1')!;
    expect(old.body).toBe('旧');
    expect(old.status).toBe('done');
    expect(next.body).toBe('新行文本');
    expect(next.status).toBe('done');
  });

  it('多次 roll 计数递增（#roll1 → #roll2），各段互不串', () => {
    seedStreamingSession('ss-r', ['A']);
    routeChunkToBuffer({ type: 'message_roll', streamSessionId: 'ss-r' });
    routeChunkToBuffer({ type: 'text', streamSessionId: 'ss-r', delta: 'B' });
    routeChunkToBuffer({ type: 'message_roll', streamSessionId: 'ss-r' });
    routeChunkToBuffer({ type: 'text', streamSessionId: 'ss-r', delta: 'C' });
    routeChunkToBuffer({ type: 'end', streamSessionId: 'ss-r', finishReason: 'stop' });
    __flushEventBufferForTest();

    const rows = listMessagesBySession('s1');
    expect(rows.find((m) => m.streamSessionId === 'ss-r')!.body).toBe('A');
    expect(rows.find((m) => m.streamSessionId === 'ss-r#roll1')!.body).toBe('B');
    expect(rows.find((m) => m.streamSessionId === 'ss-r#roll2')!.body).toBe('C');
  });

  it('end 后 roll 计数清理（同 id 再启动新流从 roll1 重新计）', () => {
    seedStreamingSession('ss-r', ['A']);
    routeChunkToBuffer({ type: 'message_roll', streamSessionId: 'ss-r' });
    routeChunkToBuffer({ type: 'end', streamSessionId: 'ss-r', finishReason: 'stop' });
    __flushEventBufferForTest();
    // 同 streamSessionId 再来一轮（理论上新流新 id，防御性验证清理不泄漏）
    seedStreamingSession('ss-r', ['B']);
    routeChunkToBuffer({ type: 'message_roll', streamSessionId: 'ss-r' });
    __flushEventBufferForTest();
    const rows = listMessagesBySession('s1');
    expect(rows.filter((m) => m.streamSessionId === 'ss-r#roll1').length).toBe(2); // 两轮各一个 roll1，无 roll2 泄漏
  });

  it('无旧行时静默跳过（不抛错不插行）', () => {
    expect(() =>
      routeChunkToBuffer({ type: 'message_roll', streamSessionId: 'ss-ghost' }),
    ).not.toThrow();
    expect(listMessagesBySession('s1').length).toBe(0);
  });
});
