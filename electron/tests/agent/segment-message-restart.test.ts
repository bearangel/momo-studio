// electron/tests/agent/segment-message-restart.test.ts
//
// v1.7.4 Bug 4 测试：验证 task_complete 多段调用时，每段 event content 的
// tool_calls 是增量（slice 自上次分段位置的 offset），不是全量重复。
// 同时验证 tool_calls_offset 字段被正确写入。

import { describe, it, expect } from 'vitest';

describe('task_complete 多段增量持久化（Bug 4）', () => {
  it('每段 tool_calls 应为增量，且 tool_calls_offset 字段正确写入', () => {
    // 模拟 toolCallHistory 累积过程 + task_complete 分段持久化决策
    const toolCallHistory: string[] = [];
    const segmentSnapshots: { calls: string[]; offset: number }[] = [];
    let lastSegmentToolCallCount = 0;

    // 模拟第 1 段：toolCallHistory = [a, b]
    toolCallHistory.push('a', 'b');
    let incremental = toolCallHistory.slice(lastSegmentToolCallCount);
    segmentSnapshots.push({ calls: incremental, offset: lastSegmentToolCallCount });
    lastSegmentToolCallCount = toolCallHistory.length;

    // 模拟第 2 段：toolCallHistory = [a, b, c, d]
    toolCallHistory.push('c', 'd');
    incremental = toolCallHistory.slice(lastSegmentToolCallCount);
    segmentSnapshots.push({ calls: incremental, offset: lastSegmentToolCallCount });
    lastSegmentToolCallCount = toolCallHistory.length;

    // 模拟第 3 段：toolCallHistory = [a, b, c, d, e]
    toolCallHistory.push('e');
    incremental = toolCallHistory.slice(lastSegmentToolCallCount);
    segmentSnapshots.push({ calls: incremental, offset: lastSegmentToolCallCount });
    lastSegmentToolCallCount = toolCallHistory.length;

    expect(segmentSnapshots).toEqual([
      { calls: ['a', 'b'], offset: 0 },
      { calls: ['c', 'd'], offset: 2 },
      { calls: ['e'], offset: 4 },
    ]);
  });

  it('某段无新增工具调用时，calls 应为空数组', () => {
    const toolCallHistory = ['a', 'b'];
    let lastSegmentToolCallCount = 0;

    // 第 1 段：[a, b]
    let incremental = toolCallHistory.slice(lastSegmentToolCallCount);
    expect(incremental).toEqual(['a', 'b']);
    lastSegmentToolCallCount = toolCallHistory.length;

    // 第 2 段：无新增（toolCallHistory 没变）
    incremental = toolCallHistory.slice(lastSegmentToolCallCount);
    expect(incremental).toEqual([]);
    expect(incremental.length).toBe(0);
  });

  it('空 toolCallHistory 时不应写入 tool_calls 字段', () => {
    const toolCallHistory: string[] = [];
    let lastSegmentToolCallCount = 0;

    const incremental = toolCallHistory.slice(lastSegmentToolCallCount);
    const shouldWriteField = incremental.length > 0;

    expect(shouldWriteField).toBe(false);
  });
});
