// electron/tests/agent/stream-relay-budget-reason.test.ts
//
// 软续期信号契约锁（2026-10-10）：
//   1. end(budget_exhausted) → 消息行 status='failed'（DB 零迁移）+ 中文错误文案
//      + final 事件 payload 附 reason='budget_exhausted'（renderer 据此呈现续期卡）
//   2. end(stop) / end(error) / end(interrupted) → final 事件不带 reason 字段
//      （旧 renderer 与无 reason 消费者行为零变化）
//
// mock 边界（momo-test-rules：只 mock DB / 日志边界，被测单元真实运行）：
//   - messages/repo + events-repo：返回可控的最小行
//   - event-buffer：捕获 append 入参（断言 payload 形状）
import { describe, it, expect, beforeEach, vi } from 'vitest';

const captured: Array<{ messageId: string; eventType: string; payload: Record<string, unknown> }> =
  vi.hoisted(() => []);

vi.mock('../../src/main/storage/messages/repo', () => ({
  insertMessage: vi.fn(),
  getMessageByStreamSessionId: vi.fn(() => ({ id: 'm-1' })),
  getLatestMessageByStreamSessionId: vi.fn(() => ({ id: 'm-1' })),
  updateMessageStatus: vi.fn(),
  getMessage: vi.fn(() => ({ id: 'm-1' })),
}));

vi.mock('../../src/main/storage/messages/events-repo', () => ({
  aggregateTextDeltas: vi.fn(() => '正文'),
}));

vi.mock('../../src/main/storage/messages/event-buffer', () => ({
  MessageEventBuffer: class {
    append(entry: { messageId: string; eventType: string; payload: Record<string, unknown> }): void {
      captured.push(entry);
    }
    flush(): void {}
    destroy(): void {}
  },
}));

vi.mock('../../src/main/storage/sessions/repo', () => ({
  getSession: vi.fn(() => null),
}));

vi.mock('../../src/main/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { __routeChunkToBufferForTest, __resetEventBufferForTest } from '../../src/main/agent/stream-relay';
import { updateMessageStatus } from '../../src/main/storage/messages/repo';

type EndFinishReason = 'stop' | 'budget_exhausted' | 'interrupted' | 'error';

function endChunk(finishReason: EndFinishReason): void {
  __routeChunkToBufferForTest({
    type: 'end',
    streamSessionId: 'ss-1',
    finishReason,
  });
}

function lastFinal(): Record<string, unknown> | undefined {
  const finals = captured.filter((c) => c.eventType === 'final');
  return finals[finals.length - 1]?.payload;
}

describe('end(budget_exhausted) 软续期信号', () => {
  beforeEach(() => {
    captured.length = 0;
    vi.clearAllMocks();
    __resetEventBufferForTest();
  });

  it('预算耗尽：行 status=failed + 中文文案 + final 附 reason', () => {
    endChunk('budget_exhausted');
    expect(updateMessageStatus).toHaveBeenCalledWith('m-1', 'failed', '正文');
    const payload = lastFinal();
    expect(payload).toBeDefined();
    expect(payload!.status).toBe('failed');
    expect(payload!.error).toBe('工具调用预算已耗尽');
    expect(payload!.reason).toBe('budget_exhausted');
  });

  it.each(['stop', 'error', 'interrupted'] as const)('finishReason=%s：final 不带 reason', (fr) => {
    endChunk(fr);
    const payload = lastFinal();
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty('reason');
  });
});
