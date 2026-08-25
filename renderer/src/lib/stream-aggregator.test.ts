// renderer/src/lib/stream-aggregator.test.ts
//
// aggregateEvents 聚合规则单测。
// 回归锁（2.0.0 主机验收 P0-3）：final 事件的 payload.status 必须被尊重——
// 此前硬编码 status='done'，失败流的错误状态与 error 文本被整个丢弃，
// agent 失败时 UI 只剩一个空的"流式中"气泡，真实错误不可见。
import { describe, it, expect } from 'vitest';
import { aggregateEvents } from './stream-aggregator';
import type { MessageEventRow } from '../ipc/types';

function ev(seq: number, eventType: MessageEventRow['eventType'], payload: Record<string, unknown>): MessageEventRow {
  return { id: `e${seq}`, messageId: 'm1', seq, eventType, payload, createdAt: seq * 1000 };
}

describe('aggregateEvents：final 事件的 status/error 处理', () => {
  it('final{status:"failed", error} → 聚合为 failed 且捕获 error 文本', () => {
    const result = aggregateEvents([
      ev(1, 'status_change', { status: 'streaming' }),
      ev(2, 'final', { status: 'failed', error: 'LLM 请求无法连接 https://x/v1：ECONNREFUSED' }),
    ]);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('LLM 请求无法连接 https://x/v1：ECONNREFUSED');
  });

  it('final{status:"aborted"} → 聚合为 aborted', () => {
    const result = aggregateEvents([
      ev(1, 'status_change', { status: 'streaming' }),
      ev(2, 'final', { status: 'aborted' }),
    ]);
    expect(result.status).toBe('aborted');
  });

  it('final{status:"done"} → done（成功路径不回归）', () => {
    const result = aggregateEvents([
      ev(1, 'text_delta', { delta: '你好' }),
      ev(2, 'final', { status: 'done' }),
    ]);
    expect(result.status).toBe('done');
    expect(result.text).toBe('你好');
  });

  it('final 无合法 status 字段（分段边界旧形状 final{body}）→ 保持 done 兜底', () => {
    const result = aggregateEvents([ev(1, 'final', { body: '第一段' })]);
    expect(result.status).toBe('done');
  });

  it('final 携带非法 status 字符串 → 不覆盖（保持事件序列推导结果）', () => {
    const result = aggregateEvents([
      ev(1, 'status_change', { status: 'streaming' }),
      ev(2, 'final', { status: 'weird-value' }),
    ]);
    expect(result.status).toBe('streaming');
  });
});

describe('aggregateEvents：基础聚合（无 final）', () => {
  it('text/thinking delta 拼接；无终态事件时保持 streaming', () => {
    const result = aggregateEvents([
      ev(1, 'thinking_delta', { delta: '想' }),
      ev(2, 'text_delta', { delta: '你好' }),
      ev(3, 'text_delta', { delta: '世界' }),
    ]);
    expect(result.thinking).toBe('想');
    expect(result.text).toBe('你好世界');
    expect(result.status).toBe('streaming');
  });
});

describe('aggregateEvents：segments 时间线（思考/工具/正文按实际发生顺序交错）', () => {
  it('thinking → tool → text → thinking → tool → text 交错保序', () => {
    const result = aggregateEvents([
      ev(1, 'thinking_delta', { delta: '先想一想' }),
      ev(2, 'tool_call_start', { callId: 'c1', toolName: 'list_files', args: { path: '.' } }),
      ev(3, 'tool_call_result', { callId: 'c1', result: 'a.md', success: true }),
      ev(4, 'text_delta', { delta: '看到文件了，' }),
      ev(5, 'thinking_delta', { delta: '再确认一下' }),
      ev(6, 'tool_call_start', { callId: 'c2', toolName: 'read_file', args: { path: 'a.md' } }),
      ev(7, 'tool_call_result', { callId: 'c2', result: '内容', success: true }),
      ev(8, 'text_delta', { delta: '内容如下' }),
    ]);

    expect(result.segments.map((s) => s.kind)).toEqual([
      'thinking', 'tool_call', 'text', 'thinking', 'tool_call', 'text',
    ]);
    const texts = result.segments.filter((s): s is Extract<typeof s, { kind: 'text' }> => s.kind === 'text');
    expect(texts[0]!.text).toBe('看到文件了，');
    expect(texts[1]!.text).toBe('内容如下');
    const tools = result.segments.filter((s): s is Extract<typeof s, { kind: 'tool_call' }> => s.kind === 'tool_call');
    expect(tools[0]!.toolName).toBe('list_files');
    expect(tools[0]!.result).toBe('a.md');
    expect(tools[1]!.toolName).toBe('read_file');
  });

  it('连续同类 delta 归并到同段（不产生碎片）', () => {
    const result = aggregateEvents([
      ev(1, 'text_delta', { delta: 'a' }),
      ev(2, 'text_delta', { delta: 'b' }),
      ev(3, 'text_delta', { delta: 'c' }),
    ]);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ kind: 'text', text: 'abc' });
  });

  it('tool_call 未收到 result 时段内 result/success 为 null（执行中）', () => {
    const result = aggregateEvents([
      ev(1, 'tool_call_start', { callId: 'c1', toolName: 'grep', args: {} }),
    ]);
    const tool = result.segments[0] as Extract<typeof result.segments[0], { kind: 'tool_call' }>;
    expect(tool.result).toBeNull();
    expect(tool.success).toBeNull();
  });

  it('dispatch 段按时间线穿插且状态更新', () => {
    const result = aggregateEvents([
      ev(1, 'text_delta', { delta: '派活' }),
      ev(2, 'dispatch_start', { callId: 'd1', subStreamSessionId: 'ss-sub', subAgentName: '码农', task: '写代码' }),
      ev(3, 'dispatch_result', { callId: 'd1', status: 'completed' }),
      ev(4, 'text_delta', { delta: '完成了' }),
    ]);
    expect(result.segments.map((s) => s.kind)).toEqual(['text', 'dispatch', 'text']);
    const dispatch = result.segments[1] as Extract<typeof result.segments[1], { kind: 'dispatch' }>;
    expect(dispatch.status).toBe('completed');
    expect(dispatch.subAgentName).toBe('码农');
  });

  it('status_change / final / segment_boundary 不产生 segments 条目', () => {
    const result = aggregateEvents([
      ev(1, 'status_change', { status: 'streaming' }),
      ev(2, 'text_delta', { delta: 'x' }),
      ev(3, 'segment_boundary', {}),
      ev(4, 'final', { status: 'done' }),
    ]);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ kind: 'text', text: 'x' });
  });
});
