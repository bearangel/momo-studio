// renderer/tests/lib/stream-aggregator.test.ts
//
// aggregateEvents 函数行为测试：A 子系统共用聚合函数
// 输入：按 seq 升序的 MessageEventRow 数组
// 输出：AggregatedStream（thinking/text 拼接 + tool_call/dispatch 配对 + todos 全量替换 + status + events 时间线）
import { describe, it, expect } from 'vitest';
import { aggregateEvents } from '../../src/lib/stream-aggregator';
import type { MessageEventRow } from '../../src/ipc/types';

function mkEvent(
  seq: number,
  eventType: MessageEventRow['eventType'],
  payload: Record<string, unknown>,
): MessageEventRow {
  return { id: `e${seq}`, messageId: 'm1', seq, eventType, payload, createdAt: seq };
}

describe('aggregateEvents', () => {
  it('空事件返回初始态', () => {
    const s = aggregateEvents([]);
    expect(s.thinking).toBe('');
    expect(s.text).toBe('');
    expect(s.toolCalls).toEqual([]);
    expect(s.todos).toEqual([]);
    expect(s.dispatches).toEqual([]);
    expect(s.status).toBe('streaming'); // 默认 streaming，final 才转 done
  });

  it('thinking_delta 拼接', () => {
    const s = aggregateEvents([
      mkEvent(0, 'thinking_delta', { delta: 'Hello' }),
      mkEvent(1, 'thinking_delta', { delta: ' world' }),
    ]);
    expect(s.thinking).toBe('Hello world');
  });

  it('text_delta 拼接', () => {
    const s = aggregateEvents([
      mkEvent(0, 'text_delta', { delta: 'foo' }),
      mkEvent(1, 'text_delta', { delta: 'bar' }),
    ]);
    expect(s.text).toBe('foobar');
  });

  it('tool_call_start + tool_call_result 配对', () => {
    const s = aggregateEvents([
      mkEvent(0, 'tool_call_start', { toolName: 'read_file', args: { path: '/a.ts' }, callId: 'c1' }),
      mkEvent(1, 'tool_call_result', { callId: 'c1', result: 'file content', success: true }),
    ]);
    expect(s.toolCalls.length).toBe(1);
    expect(s.toolCalls[0]).toEqual({
      callId: 'c1',
      toolName: 'read_file',
      args: { path: '/a.ts' },
      result: 'file content',
      success: true,
    });
  });

  it('多个 tool_call 互不干扰（按 callId 配对）', () => {
    const s = aggregateEvents([
      mkEvent(0, 'tool_call_start', { toolName: 'a', args: {}, callId: 'c1' }),
      mkEvent(1, 'tool_call_start', { toolName: 'b', args: {}, callId: 'c2' }),
      mkEvent(2, 'tool_call_result', { callId: 'c2', result: 'rb', success: true }),
      mkEvent(3, 'tool_call_result', { callId: 'c1', result: 'ra', success: false }),
    ]);
    expect(s.toolCalls.length).toBe(2);
    const a = s.toolCalls.find((t) => t.callId === 'c1');
    const b = s.toolCalls.find((t) => t.callId === 'c2');
    expect(a?.success).toBe(false);
    expect(b?.success).toBe(true);
  });

  it('tool_call_start 但无 result（执行中）', () => {
    const s = aggregateEvents([
      mkEvent(0, 'tool_call_start', { toolName: 'a', args: {}, callId: 'c1' }),
    ]);
    expect(s.toolCalls.length).toBe(1);
    expect(s.toolCalls[0]).toMatchObject({ callId: 'c1', result: null, success: null });
  });

  it('todo_update 全量替换（最后一次为准）', () => {
    const s = aggregateEvents([
      mkEvent(0, 'todo_update', { todos: [{ id: '1', subject: 'a', status: 'pending' }] }),
      mkEvent(1, 'todo_update', { todos: [{ id: '2', subject: 'b', status: 'in_progress' }] }),
    ]);
    expect(s.todos.length).toBe(1);
    expect(s.todos[0]?.id).toBe('2');
  });

  it('dispatch_start + dispatch_result 配对', () => {
    const s = aggregateEvents([
      mkEvent(0, 'dispatch_start', {
        callId: 'd1',
        subStreamSessionId: 'sss1',
        subAgentName: 'Programmer',
        subAgentAvatar: '🤖',
        task: '写登录页',
      }),
      mkEvent(1, 'dispatch_result', { callId: 'd1', status: 'completed' }),
    ]);
    expect(s.dispatches.length).toBe(1);
    expect(s.dispatches[0]).toMatchObject({
      callId: 'd1',
      subStreamSessionId: 'sss1',
      subAgentName: 'Programmer',
      status: 'completed',
    });
  });

  it('segment_boundary 标记（保留在 events 时间线，不参与聚合）', () => {
    const s = aggregateEvents([
      mkEvent(0, 'text_delta', { delta: 'a' }),
      mkEvent(1, 'segment_boundary', { index: 0, total: 3 }),
      mkEvent(2, 'text_delta', { delta: 'b' }),
    ]);
    expect(s.text).toBe('ab'); // 跨 segment 仍拼接
    expect(s.events.some((e) => e.type === 'segment_boundary')).toBe(true);
  });

  it('status_change 变更状态', () => {
    const s = aggregateEvents([
      mkEvent(0, 'status_change', { status: 'streaming' }),
      mkEvent(1, 'status_change', { status: 'failed' }),
    ]);
    expect(s.status).toBe('failed');
  });

  it('final 事件转 status=done', () => {
    const s = aggregateEvents([
      mkEvent(0, 'text_delta', { delta: 'a' }),
      mkEvent(1, 'final', { body: 'a' }),
    ]);
    expect(s.status).toBe('done');
  });

  it('events 时间线按 seq 升序', () => {
    const s = aggregateEvents([
      mkEvent(2, 'text_delta', { delta: 'c' }),
      mkEvent(0, 'thinking_delta', { delta: 'a' }),
      mkEvent(1, 'text_delta', { delta: 'b' }),
    ]);
    expect(s.events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});