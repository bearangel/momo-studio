// electron/tests/storage/event-buffer-failure.test.ts
//
// minor-2 回归锁：insertEventBatch 失败时 pending 必须保留（待重试）+
// logger.error 记录，onFlush 不触发。旧实现先 this.pending = [] 再 insert，
// DB 锁定 / 磁盘满时整批事件静默丢失。
//
// mock 边界：只 mock events-repo（可控失败）与 logger；被测单元 MessageEventBuffer 真实运行。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const bufState = vi.hoisted(() => ({ failInsert: false }));

vi.mock('../../src/main/storage/messages/events-repo', () => ({
  nextSeqForMessage: vi.fn(() => 0),
  insertEventBatch: vi.fn((rows: Array<Record<string, unknown>>) => {
    if (bufState.failInsert) throw new Error('database is locked');
    return rows.map((r, i) => ({ id: `e-${i}`, createdAt: 0, ...r }));
  }),
}));

vi.mock('../../src/main/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { MessageEventBuffer } from '../../src/main/storage/messages/event-buffer';
import { insertEventBatch } from '../../src/main/storage/messages/events-repo';
import { logger } from '../../src/main/logger';

describe('MessageEventBuffer 落库失败保留 pending（minor-2）', () => {
  beforeEach(() => {
    bufState.failInsert = false;
    vi.clearAllMocks();
  });

  it('insertEventBatch 抛错 → pending 保留 + logger.error + onFlush 不触发', () => {
    bufState.failInsert = true;
    const onFlush = vi.fn();
    const buf = new MessageEventBuffer({ flushMs: 1000, onFlush });

    buf.append({ messageId: 'm1', eventType: 'text_delta', payload: { delta: 'a' } });
    buf.flush();

    expect(buf.pendingCount()).toBe(1); // 关键断言：失败不清空
    expect(logger.error).toHaveBeenCalledWith(
      'MessageEventBuffer 批量落库失败（pending 保留待重试）',
      expect.objectContaining({ batchSize: 1, error: 'database is locked' }),
    );
    expect(onFlush).not.toHaveBeenCalled();
    buf.destroy();
  });

  it('失败后恢复 → 同一批事件重试成功落库（不丢失）', () => {
    const onFlush = vi.fn();
    const buf = new MessageEventBuffer({ flushMs: 1000, onFlush });

    buf.append({ messageId: 'm1', eventType: 'text_delta', payload: { delta: 'a' } });
    bufState.failInsert = true;
    buf.flush();
    expect(buf.pendingCount()).toBe(1);

    // 故障恢复后再次 flush——保留的 pending 应完整落库
    bufState.failInsert = false;
    buf.append({ messageId: 'm1', eventType: 'text_delta', payload: { delta: 'b' } });
    buf.flush();

    expect(buf.pendingCount()).toBe(0);
    expect(onFlush).toHaveBeenCalledOnce();
    const flushed = onFlush.mock.calls[0][0] as Array<{ eventType: string }>;
    expect(flushed).toHaveLength(2); // 失败批次 + 新增的一条都在
    expect(insertEventBatch).toHaveBeenCalledTimes(2);
    buf.destroy();
  });
});
