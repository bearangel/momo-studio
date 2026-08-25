// electron/tests/agent/stream-relay-error-paths.test.ts
//
// C5 回归锁：routeChunkToBuffer 的 catch 分级。
//   - SQLite "no such table"（测试环境 / 表未迁移）→ logger.debug，不刷 error
//   - 真实 DB 故障（如 database is locked）→ logger.error（中文文案），中继不崩溃
// 旧实现 catch-all 全部按 debug 静默——磁盘满 / 库锁定等生产故障零线索。
//
// mock 边界（momo-test-rules：只 mock DB / 日志边界，被测单元真实运行）：
//   - messages/repo：可控抛错
//   - event-buffer：空实现（本测试不触达批量落盘路径的 DB）
//   - logger：spy 断言分级
import { describe, it, expect, beforeEach, vi } from 'vitest';

const relayState = vi.hoisted(() => ({
  /** 'ok' | 'notable' | 'locked'——控制 repo 抛错模式 */
  mode: 'ok' as 'ok' | 'notable' | 'locked',
  /** getMessageByStreamSessionId 的返回（end 分支需要） */
  msgById: null as null | { id: string },
}));

vi.mock('../../src/main/storage/messages/repo', () => ({
  insertMessage: vi.fn(() => {
    if (relayState.mode === 'notable') throw new Error('no such table: messages');
    if (relayState.mode === 'locked') throw new Error('database is locked');
    return { id: 'm-ok' };
  }),
  getMessageByStreamSessionId: vi.fn(() => relayState.msgById),
  updateMessageStatus: vi.fn(() => {
    if (relayState.mode === 'locked') throw new Error('database is locked');
  }),
}));

vi.mock('../../src/main/storage/messages/event-buffer', () => ({
  MessageEventBuffer: class {
    append(): void {}
    flush(): void {}
    destroy(): void {}
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { __routeChunkToBufferForTest, __resetEventBufferForTest } from '../../src/main/agent/stream-relay';
import { logger } from '../../src/main/logger';

describe('routeChunkToBuffer 错误分级（C5）', () => {
  beforeEach(() => {
    relayState.mode = 'ok';
    relayState.msgById = null;
    vi.clearAllMocks();
    __resetEventBufferForTest();
  });

  it('SQLite "no such table"（DB 未就绪）→ logger.debug，不刷 error', () => {
    relayState.mode = 'notable';

    expect(() =>
      __routeChunkToBufferForTest({
        type: 'start',
        streamSessionId: 'ss-notable',
        sessionId: '!r:x',
        senderAgentId: '@bot:x',
      }),
    ).not.toThrow();

    expect(logger.debug).toHaveBeenCalledWith(
      'routeChunkToBuffer 跳过（DB 未就绪或表不存在）',
      expect.objectContaining({ chunkType: 'start', error: expect.stringContaining('no such table') }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('真实 DB 故障（database is locked）→ logger.error（中文文案），中继不崩溃', () => {
    relayState.mode = 'locked';
    relayState.msgById = { id: 'm-1' };

    expect(() =>
      __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-locked', finishReason: 'stop' }),
    ).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      'routeChunkToBuffer 落盘失败（chunk 已跳过，流式中继继续）',
      expect.objectContaining({ chunkType: 'end', error: 'database is locked' }),
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
