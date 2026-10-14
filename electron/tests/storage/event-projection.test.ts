// electron/tests/storage/event-projection.test.ts
//
// thinking wire 截断（2026-10-14 会话切换延迟修复 P0-2）契约锁：
// 真机剖析 spring-mcp 39.5 万事件 / 10.4MB，thinking 全文 ≈ 4.8MB 全量跨 IPC
// 是切换延迟主因——历史加载路径对终态消息截断 thinking 至预算，展开经
// session:getMessageThinking 按需拉全量（renderer expandThinking 按 seq 归并）。
// 本文件锁投影规则本身；两端契约（截断版 → 聚合 → 展开 → 全量）由
// events-pruning.test.ts（electron 侧 round-trip）+ stream.store.test.ts
// （renderer 侧归并）分持。
import { describe, it, expect } from 'vitest';
import {
  projectEventForWire,
  projectEventsForWire,
  truncateThinkingForWire,
  truncateToolResultsForWire,
  THINKING_WIRE_BUDGET,
  TOOL_RESULT_WIRE_BUDGET,
  THINKING_TRUNCATED_SEQ,
} from '../../src/main/storage/messages/event-projection';
import type { MessageEventRow } from '../../src/main/storage/messages/events-repo';

let seqCounter = 0;
function ev(
  eventType: MessageEventRow['eventType'],
  payload: Record<string, unknown>,
  messageId = 'm-1',
): MessageEventRow {
  return {
    id: `e${seqCounter++}`,
    messageId,
    seq: seqCounter,
    eventType,
    payload,
    createdAt: 1000 + seqCounter,
  };
}

describe('truncateThinkingForWire', () => {
  it('终态消息 thinking 超预算 → 截断至预算 + 末尾追加 marker（携全量字符数）', () => {
    const big = 'x'.repeat(THINKING_WIRE_BUDGET + 500);
    const events = [
      ev('thinking_delta', { delta: big }),
      ev('text_delta', { delta: '正文' }),
      ev('final', { status: 'done' }),
    ];
    const out = truncateThinkingForWire(events);
    const thinking = out.filter((e) => e.eventType === 'thinking_delta');
    expect(thinking).toHaveLength(1);
    expect((thinking[0]!.payload as { delta: string }).delta).toHaveLength(THINKING_WIRE_BUDGET);
    // 非 thinking 事件原样保留（保序）
    expect(out.map((e) => e.eventType)).toEqual(['thinking_delta', 'text_delta', 'final', 'thinking_truncated']);
    const marker = out[out.length - 1]!;
    expect(marker.eventType).toBe('thinking_truncated');
    expect(marker.seq).toBe(THINKING_TRUNCATED_SEQ);
    expect(marker.payload.fullChars).toBe(THINKING_WIRE_BUDGET + 500);
  });

  it('多个 thinking 游程：预算跨游程切分——首游程全保留，次游程切，后续丢弃', () => {
    const events = [
      ev('thinking_delta', { delta: 'a'.repeat(THINKING_WIRE_BUDGET - 10) }),
      ev('text_delta', { delta: '中间正文' }),
      ev('thinking_delta', { delta: 'b'.repeat(100) }),
      ev('thinking_delta', { delta: 'c'.repeat(50) }),
      ev('final', { status: 'done' }),
    ];
    const out = truncateThinkingForWire(events);
    const thinking = out.filter((e) => e.eventType === 'thinking_delta');
    expect(thinking).toHaveLength(2);
    expect((thinking[0]!.payload as { delta: string }).delta).toHaveLength(THINKING_WIRE_BUDGET - 10);
    expect((thinking[1]!.payload as { delta: string }).delta).toHaveLength(10); // 只剩 10 字符预算
    const marker = out[out.length - 1]!;
    expect(marker.payload.fullChars).toBe(THINKING_WIRE_BUDGET - 10 + 100 + 50);
  });

  it('终态但 thinking 未超预算 → 原样返回（零截断零 marker）', () => {
    const events = [
      ev('thinking_delta', { delta: '短思考' }),
      ev('final', { status: 'done' }),
    ];
    expect(truncateThinkingForWire(events)).toBe(events);
  });

  it('流式消息（无 final / status_change 终态）不截断——实时 thinking 不动', () => {
    const events = [
      ev('thinking_delta', { delta: 'x'.repeat(THINKING_WIRE_BUDGET * 3) }),
      ev('text_delta', { delta: '进行中' }),
    ];
    expect(truncateThinkingForWire(events)).toBe(events);
  });

  it('旧形状 final（无 status 字段）按终态判定（与聚合器 done 兜底同口径）', () => {
    const events = [
      ev('thinking_delta', { delta: 'y'.repeat(THINKING_WIRE_BUDGET + 1) }),
      ev('final', {}),
    ];
    const out = truncateThinkingForWire(events);
    expect(out[out.length - 1]!.eventType).toBe('thinking_truncated');
  });

  it('status_change=aborted 终态同样截断；status_change=streaming 不算终态', () => {
    const aborted = [ev('thinking_delta', { delta: 'z'.repeat(THINKING_WIRE_BUDGET + 1) }), ev('status_change', { status: 'aborted' })];
    expect(truncateThinkingForWire(aborted).at(-1)!.eventType).toBe('thinking_truncated');
    const live = [ev('thinking_delta', { delta: 'z'.repeat(THINKING_WIRE_BUDGET + 1) }), ev('status_change', { status: 'streaming' })];
    expect(truncateThinkingForWire(live)).toBe(live);
  });

  it('无 thinking 事件的终态消息 → 原样返回（快路径）', () => {
    const events = [ev('text_delta', { delta: '纯正文' }), ev('final', { status: 'done' })];
    expect(truncateThinkingForWire(events)).toBe(events);
  });
});

describe('projectEventsForWire（I2 steer 剥离回归 + 与截断可组合）', () => {
  it('steer 事件剥离 context，其余透传（既有契约不回归）', () => {
    const steer = ev('steer', { body: 'b', context: { skills: [], files: [] } });
    const text = ev('text_delta', { delta: 'x' });
    const out = projectEventsForWire([steer, text]);
    expect(out[0]!.payload).toEqual({ body: 'b' });
    expect(out[1]).toBe(text);
  });

  it('projectEventForWire 非 steer 零拷贝透传', () => {
    const e = ev('thinking_delta', { delta: 'd' });
    expect(projectEventForWire(e)).toBe(e);
  });

  it('截断可组合在投影之后（events-pruning 调用序契约）', () => {
    const events = [
      ev('steer', { body: 'b', context: { skills: [], files: [] } }),
      ev('thinking_delta', { delta: 'k'.repeat(THINKING_WIRE_BUDGET + 5) }),
      ev('final', { status: 'done' }),
    ];
    const out = truncateThinkingForWire(projectEventsForWire(events));
    expect(out[0]!.payload).not.toHaveProperty('context');
    expect(out.at(-1)!.eventType).toBe('thinking_truncated');
  });
});

// === tool_call_result wire 截断（第二刀）契约锁 ===
describe('truncateToolResultsForWire', () => {
  it('终态消息超预算结果 → 截至预算 + payload 内嵌 truncated/fullLength（无 marker 事件）', () => {
    const big = 'r'.repeat(TOOL_RESULT_WIRE_BUDGET + 300);
    const events = [
      ev('tool_call_start', { callId: 'c1', toolName: 'bash', args: {} }),
      ev('tool_call_result', { callId: 'c1', result: big, success: true }),
      ev('final', { status: 'done' }),
    ];
    const out = truncateToolResultsForWire(events);
    expect(out).toHaveLength(3); // 无追加事件
    const res = out[1]!;
    expect((res.payload as { result: string }).result).toHaveLength(TOOL_RESULT_WIRE_BUDGET);
    expect(res.payload.truncated).toBe(true);
    expect(res.payload.fullLength).toBe(TOOL_RESULT_WIRE_BUDGET + 300);
    // 兄弟字段保留
    expect(res.payload.success).toBe(true);
    expect(res.payload.callId).toBe('c1');
    // 其余事件原引用透传
    expect(out[0]).toBe(events[0]);
    expect(out[2]).toBe(events[2]);
  });

  it('多条超预算结果各自独立截断；短结果与无 result 事件不动', () => {
    const events = [
      ev('tool_call_result', { callId: 'a', result: 'x'.repeat(TOOL_RESULT_WIRE_BUDGET + 1) }),
      ev('tool_call_result', { callId: 'b', result: 'short' }),
      ev('tool_call_result', { callId: 'c', subStatus: 'completed' }), // dispatch 回执：无 result 字符串
      ev('tool_call_result', { callId: 'd', result: 'y'.repeat(TOOL_RESULT_WIRE_BUDGET + 2) }),
      ev('final', { status: 'done' }),
    ];
    const out = truncateToolResultsForWire(events);
    expect(out[0]!.payload.truncated).toBe(true);
    expect(out[1]).toBe(events[1]);
    expect(out[2]).toBe(events[2]);
    expect(out[3]!.payload.truncated).toBe(true);
    expect((out[3]!.payload as { result: string }).result).toHaveLength(TOOL_RESULT_WIRE_BUDGET);
  });

  it('全部未超预算 / 流式消息 → 原引用返回（零拷贝快路径）', () => {
    const done = [ev('tool_call_result', { callId: 'a', result: 'ok' }), ev('final', { status: 'done' })];
    expect(truncateToolResultsForWire(done)).toBe(done);
    const live = [ev('tool_call_result', { callId: 'a', result: 'z'.repeat(TOOL_RESULT_WIRE_BUDGET * 3) })];
    expect(truncateToolResultsForWire(live)).toBe(live);
  });
});
