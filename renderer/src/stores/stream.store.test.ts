// renderer/src/stores/stream.store.test.ts
//
// stream.store 聚合行为单测。
// 回归锁（2.0.0 主机验收 P0-4）：hydrateFromEvents 对空 events 数组必须 no-op——
// 此前空数组也写入 streams（aggregateEvents([]) 默认 status='streaming'），
// 重启后所有零事件消息（用户消息）被灌入幽灵流式状态，MessageBubble 把它们
// 渲染成空的"流式中"气泡，用户消息文本完全不显示。
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamStore } from './stream.store';
import type { MessageEventRow } from '../ipc/types';

function ev(seq: number, eventType: MessageEventRow['eventType'], payload: Record<string, unknown>): MessageEventRow {
  return { id: `e${seq}`, messageId: 'm1', seq, eventType, payload, createdAt: seq * 1000 };
}

describe('hydrateFromEvents 空 events 防御（P0-4）', () => {
  beforeEach(() => {
    useStreamStore.getState().reset();
  });

  it('空 events 数组 → 不创建 streams 条目（用户消息保持静态气泡渲染）', () => {
    useStreamStore.getState().hydrateFromEvents('owner-msg-1', []);
    expect(useStreamStore.getState().streams.has('owner-msg-1')).toBe(false);
  });

  it('非空 events → 正常聚合（agent 消息富气泡不受影响）', () => {
    useStreamStore.getState().hydrateFromEvents('agent-msg-1', [
      ev(1, 'status_change', { status: 'streaming' }),
      ev(2, 'text_delta', { delta: '你好' }),
      ev(3, 'final', { status: 'done' }),
    ]);
    const s = useStreamStore.getState().streams.get('agent-msg-1');
    expect(s).toBeDefined();
    expect(s!.text).toBe('你好');
    expect(s!.status).toBe('done');
  });

  it('先空后实（同 messageId 二次 hydrate）→ 实数据正常生效', () => {
    useStreamStore.getState().hydrateFromEvents('m2', []);
    expect(useStreamStore.getState().streams.has('m2')).toBe(false);
    useStreamStore.getState().hydrateFromEvents('m2', [ev(1, 'text_delta', { delta: 'x' })]);
    const s = useStreamStore.getState().streams.get('m2');
    expect(s?.text).toBe('x');
  });
});

describe('applyEventBatch 去重键（P0-5：占位 id 不得误杀后续批次）', () => {
  beforeEach(() => {
    useStreamStore.getState().reset();
  });

  it('不同批次、同占位 id、不同 seq → 两条都累积（修复前第二批被去重吞掉）', () => {
    // 仿真修复前的主进程行为：两批事件 id 同为 'buffered' 占位
    useStreamStore.getState().applyEventBatch([
      { id: 'buffered', messageId: 'm9', seq: 1, eventType: 'status_change', payload: { status: 'streaming' }, createdAt: 1 },
    ]);
    useStreamStore.getState().applyEventBatch([
      { id: 'buffered', messageId: 'm9', seq: 2, eventType: 'text_delta', payload: { delta: '第一' }, createdAt: 2 },
      { id: 'buffered', messageId: 'm9', seq: 3, eventType: 'text_delta', payload: { delta: '批' }, createdAt: 3 },
    ]);
    const s = useStreamStore.getState().streams.get('m9');
    expect(s).toBeDefined();
    expect(s!.text).toBe('第一批');
  });

  it('真重复（同 messageId 同 seq 重放）→ 仍被去重', () => {
    useStreamStore.getState().applyEventBatch([
      { id: 'real-1', messageId: 'm10', seq: 1, eventType: 'text_delta', payload: { delta: 'a' }, createdAt: 1 },
    ]);
    useStreamStore.getState().applyEventBatch([
      { id: 'real-1-dup', messageId: 'm10', seq: 1, eventType: 'text_delta', payload: { delta: 'a' }, createdAt: 1 },
    ]);
    const s = useStreamStore.getState().streams.get('m10');
    expect(s!.text).toBe('a');
    expect(s!.events.length).toBe(1);
  });
});
