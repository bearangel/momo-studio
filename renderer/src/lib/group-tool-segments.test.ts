// groupToolSegments 单测：连续只读工具合并 / 单个不合并 / 非只读打断 /
// todowrite 过滤 / 与 thinking/text 段交错保序 / 末尾连续 flush。
import { describe, it, expect } from 'vitest';
import { groupToolSegments } from './group-tool-segments';
import type { StreamSegment } from './stream-aggregator';

function tool(callId: string, toolName: string): Extract<StreamSegment, { kind: 'tool_call' }> {
  return { kind: 'tool_call', callId, toolName, args: {}, result: 'ok', success: true };
}

describe('groupToolSegments', () => {
  it('连续 ≥2 个只读工具合并为 context-group', () => {
    const out = groupToolSegments([tool('c1', 'read_file'), tool('c2', 'glob'), tool('c3', 'grep')]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('context-group');
    if (out[0]?.kind === 'context-group') {
      expect(out[0].items).toHaveLength(3);
    }
  });

  it('单个只读工具不合并（照旧独立 tool_call）', () => {
    const out = groupToolSegments([tool('c1', 'read_file')]);
    expect(out).toEqual([tool('c1', 'read_file')]);
  });

  it('非只读工具打断连续段（两组各自成块）', () => {
    // 简化为直接断言每段 kind 与数量：c1 单独 / c2 bash / {c3,c4} 合并
    const out = groupToolSegments([
      tool('c1', 'read_file'),
      tool('c2', 'bash'),
      tool('c3', 'read_file'),
      tool('c4', 'grep'),
    ]);
    expect(out).toHaveLength(3);
    // 段 0:c1 单独成 tool_call
    expect(out[0]?.kind).toBe('tool_call');
    if (out[0]?.kind === 'tool_call') expect(out[0].toolName).toBe('read_file');
    // 段 1:bash 独立 tool_call(非只读直接透传)
    expect(out[1]?.kind).toBe('tool_call');
    if (out[1]?.kind === 'tool_call') expect(out[1].toolName).toBe('bash');
    // 段 2:c3+c4 两个只读工具合并为 context-group
    expect(out[2]?.kind).toBe('context-group');
    if (out[2]?.kind === 'context-group') {
      expect(out[2].items).toHaveLength(2);
    }
  });

  it('todowrite 段被过滤（TodoSection 已展示）', () => {
    const out = groupToolSegments([tool('c1', 'todowrite'), { kind: 'text', text: 'hi' }]);
    expect(out).toEqual([{ kind: 'text', text: 'hi' }]);
  });

  it('todowrite 不打断连续只读段（透明过滤，HIDDEN 判定先于分组且不 flush）', () => {
    const out = groupToolSegments([
      tool('c1', 'read_file'),
      tool('c2', 'todowrite'),
      tool('c3', 'read_file'),
    ]);
    expect(out).toHaveLength(1);
    const first = out[0];
    if (first?.kind === 'context-group') {
      expect(first.items.map((i) => i.callId)).toEqual(['c1', 'c3']);
    } else {
      throw new Error('期望 context-group，实际 ' + String(first?.kind));
    }
  });

  it('全 todowrite 输入返回空数组', () => {
    expect(groupToolSegments([tool('c1', 'todowrite'), tool('c2', 'todowrite')])).toEqual([]);
  });

  it('与 thinking/text 交错保序', () => {
    const out = groupToolSegments([
      { kind: 'thinking', text: '想' },
      tool('c1', 'read_file'),
      tool('c2', 'list_files'),
      { kind: 'text', text: '说' },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ kind: 'thinking', text: '想' });
    expect(out[1]?.kind).toBe('context-group');
    if (out[1]?.kind === 'context-group') {
      expect(out[1].items).toHaveLength(2);
    }
    expect(out[2]).toEqual({ kind: 'text', text: '说' });
  });

  it('末尾连续只读工具也合并（flush 兜底）', () => {
    const out = groupToolSegments([{ kind: 'text', text: 'a' }, tool('c1', 'grep'), tool('c2', 'glob')]);
    expect(out).toHaveLength(2);
    expect(out[1]?.kind).toBe('context-group');
  });
});
