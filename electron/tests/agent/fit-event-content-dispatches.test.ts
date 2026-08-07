// v1.5.5 验证：PDU 渐进式截断时 dispatches 字段必须保留（重启 DispatchChip 还原依据）
import { describe, it, expect } from 'vitest';
import { __fitEventContentForTest, __extractDispatchesForTest } from '../../src/main/agent/runtime-entry';
import type { ToolCallRecord } from '../../src/main/agent/runtime-entry';

describe('fitEventContent v1.5.5 — dispatches 字段在截断中保留', () => {
  const dispatchEntry: ToolCallRecord = {
    name: 'dispatch:programmer',
    args: { task: 'do something' },
    result: '完成',
    success: true,
    isDispatch: true,
    subStreamSessionId: 'sub-sess-001',
    subAgentName: '程序员',
    subAgentAvatar: '🤖',
  };
  const normalCall: ToolCallRecord = {
    name: 'bash',
    args: { command: 'ls -la' },
    result: 'a\nb\nc',
    success: true,
  };

  it('extractDispatches 过滤 isDispatch=true 的 entries', () => {
    const result = __extractDispatchesForTest([dispatchEntry, normalCall]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('dispatch:programmer');
    expect(result[0]!.subStreamSessionId).toBe('sub-sess-001');
    expect(result[0]!.subAgentName).toBe('程序员');
  });

  it('extractDispatches 也兼容 name 前缀 dispatch:（向后兼容）', () => {
    const noFlag: ToolCallRecord = {
      name: 'dispatch:writer',
      args: {},
      result: '',
      success: true,
    };
    const result = __extractDispatchesForTest([noFlag]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('dispatch:writer');
  });

  it('完整内容不超 PDU 时不触发截断（dispatches + tool_calls 都在）', () => {
    const content: Record<string, unknown> = {
      msgtype: 'm.text',
      body: 'short body',
      'io.momo-studio.stream_session_id': 'sess-1',
      'io.momo-studio.tool_calls': [dispatchEntry, normalCall],
      'io.momo-studio.dispatches': __extractDispatchesForTest([dispatchEntry, normalCall]),
    };
    const fitted = __fitEventContentForTest(content, '', [dispatchEntry, normalCall]);
    expect(fitted['io.momo-studio.dispatches']).toBeDefined();
    expect(fitted['io.momo-studio.tool_calls']).toBeDefined();
  });

  it('超 PDU 触发 4 级截断删除 tool_calls 时，dispatches 字段保留', () => {
    // 构造让 1+2+3 级都不够的极端内容：thinking 60KB + body 60KB
    //   0级: 120KB > 55KB → 1级（截 tool 字段）
    //   1级: ~120KB → 2级（截 thinking 到 3KB）
    //   2级: 3KB + 60KB = 63KB > 55KB → 3级（删 thinking）
    //   3级: 60KB > 55KB → 4级（删 tool_calls）
    //   4级: dispatches + body 60KB > 55KB → 5级（截 body 到 10KB）
    const hugeThinking = 'x'.repeat(60_000);
    const hugeBody = 'y'.repeat(60_000);
    const content: Record<string, unknown> = {
      msgtype: 'm.text',
      body: hugeBody,
      'io.momo-studio.stream_session_id': 'sess-2',
      'io.momo-studio.thinking': hugeThinking,
      'io.momo-studio.tool_calls': [dispatchEntry, normalCall],
      'io.momo-studio.dispatches': __extractDispatchesForTest([dispatchEntry, normalCall]),
    };
    const fitted = __fitEventContentForTest(content, hugeThinking, [dispatchEntry, normalCall]);

    // 验证：tool_calls 被删（4级触发）
    expect(fitted['io.momo-studio.tool_calls']).toBeUndefined();
    // **关键断言**：dispatches 必须保留
    expect(fitted['io.momo-studio.dispatches']).toBeDefined();
    const dispatches = fitted['io.momo-studio.dispatches'] as Array<{ name: string }>;
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.name).toBe('dispatch:programmer');
  });

  it('极端超 PDU 触发 5 级截断 body 时，dispatches 仍保留', () => {
    // 构造巨大 body 单独超 PDU（thinking 和 tool_calls 都没有，只剩 body+dispatches）
    const hugeBody = 'z'.repeat(80_000);
    const content: Record<string, unknown> = {
      msgtype: 'm.text',
      body: hugeBody,
      'io.momo-studio.stream_session_id': 'sess-3',
      'io.momo-studio.dispatches': __extractDispatchesForTest([dispatchEntry]),
    };
    const fitted = __fitEventContentForTest(content, '', []);
    // body 被截断
    const body = fitted.body as string;
    expect(body.length).toBeLessThan(hugeBody.length);
    expect(body).toContain('正文已截断');
    // **关键断言**：dispatches 必须保留
    expect(fitted['io.momo-studio.dispatches']).toBeDefined();
  });
});
