// renderer/tests/stores/stream.store.test.ts
//
// stream.store（A 子系统重写）行为测试：
//   - applyEventBatch 累积 events，按 messageId 聚合为 StreamState
//   - final 事件后 status=done
//   - 增量 append（先 1 条，再 2 条），text 拼接正确
//   - hydrateFromEvents 重启场景：从 IPC 拉的 events 初始化
//   - reset 清空所有 streams
//
// 数据来源：MessageEventRow（SQLite message_events 表 row），不再依赖 IPC StreamChunk。
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamStore } from '../../src/stores/stream.store';
import type { MessageEventRow } from '../../src/ipc/types';

/** 构造一条 MessageEventRow（seq 同时作为 createdAt，便于断言） */
function mkEvent(
  messageId: string,
  seq: number,
  eventType: MessageEventRow['eventType'],
  payload: Record<string, unknown>,
): MessageEventRow {
  return {
    id: `e${messageId}-${seq}`,
    messageId,
    seq,
    eventType,
    payload,
    createdAt: seq,
  };
}

describe('stream.store (A 子系统重写)', () => {
  beforeEach(() => {
    useStreamStore.getState().reset();
  });

  // 注：zustand 的 getState() 返回 state 快照，set 后旧快照不会同步更新。
  // 因此每个断言点都重新 getState() 拿最新 state，而不是复用 store 变量读 streams。
  it('applyEventBatch 累积 events，按 messageId 聚合为 StreamState', () => {
    useStreamStore.getState().applyEventBatch([
      mkEvent('m1', 0, 'thinking_delta', { delta: 'think' }),
      mkEvent('m1', 1, 'text_delta', { delta: 'hi' }),
    ]);
    const stream = useStreamStore.getState().streams.get('m1');
    expect(stream).toBeDefined();
    expect(stream!.thinking).toBe('think');
    expect(stream!.text).toBe('hi');
    expect(stream!.status).toBe('streaming');
  });

  it('final 事件后 status=done', () => {
    useStreamStore.getState().applyEventBatch([
      mkEvent('m1', 0, 'text_delta', { delta: 'a' }),
      mkEvent('m1', 1, 'final', {}),
    ]);
    expect(useStreamStore.getState().streams.get('m1')?.status).toBe('done');
  });

  it('增量 append（先 1 条，再 2 条），text 拼接正确', () => {
    useStreamStore.getState().applyEventBatch([mkEvent('m1', 0, 'text_delta', { delta: 'a' })]);
    useStreamStore.getState().applyEventBatch([
      mkEvent('m1', 1, 'text_delta', { delta: 'b' }),
      mkEvent('m1', 2, 'text_delta', { delta: 'c' }),
    ]);
    expect(useStreamStore.getState().streams.get('m1')?.text).toBe('abc');
  });

  it('从 ImStore eventsByMessage 初始化（重启场景）', () => {
    const events = [
      mkEvent('m2', 0, 'thinking_delta', { delta: 'past' }),
      mkEvent('m2', 1, 'final', {}),
    ];
    useStreamStore.getState().hydrateFromEvents('m2', events);
    expect(useStreamStore.getState().streams.get('m2')?.thinking).toBe('past');
    expect(useStreamStore.getState().streams.get('m2')?.status).toBe('done');
  });

  it('reset 清空所有 streams', () => {
    useStreamStore.getState().applyEventBatch([mkEvent('m1', 0, 'text_delta', { delta: 'a' })]);
    useStreamStore.getState().reset();
    expect(useStreamStore.getState().streams.size).toBe(0);
  });
});
