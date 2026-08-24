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
