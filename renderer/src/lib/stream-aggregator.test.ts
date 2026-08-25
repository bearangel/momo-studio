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

describe('aggregateEvents：终态收敛（停止/崩溃后 pending 段不再永久执行中）', () => {
  // 回归锁（用户报障）：runtime 中断路径刻意不回填 tool_result（防「中断-重试」
  // 死循环，runtime-entry v1.5.2 决策），事件序列里 tool_call_start / dispatch
  // start 之后直接跟 final。聚合层若不收敛这些 pending 段，UI 会永久显示
  // 「执行中」+ dispatch chip 计时器持续跳动（实时与重启两路径共用本函数）。

  it('aborted 终态：pending 工具段收敛为 (已中断)+success=false（bug 1 回归锁）', () => {
    const result = aggregateEvents([
      ev(1, 'status_change', { status: 'streaming' }),
      ev(2, 'thinking_delta', { delta: '先查一下' }),
      ev(3, 'tool_call_start', { callId: 'c1', toolName: 'grep', args: { pattern: 'foo' } }),
      ev(4, 'final', { status: 'aborted' }),
    ]);
    expect(result.status).toBe('aborted');
    // 段（UI 时间线渲染依据）
    const tool = result.segments.find((s) => s.kind === 'tool_call') as Extract<
      typeof result.segments[number],
      { kind: 'tool_call' }
    >;
    expect(tool.result).toBe('(已中断)');
    expect(tool.success).toBe(false);
    // 平铺 toolCalls 与段一致
    expect(result.toolCalls[0]).toMatchObject({ callId: 'c1', result: '(已中断)', success: false });
  });

  it('aborted 终态：pending dispatch 段收敛为 aborted（bug 2 回归锁）', () => {
    // 生产链路真实形状：dispatch 委派以 tool_call_start(isDispatch) 落库（P0-6），
    // 中断后无 tool_call_result —— chip 不应停在 executing（计时器永久跳动）
    const result = aggregateEvents([
      ev(1, 'status_change', { status: 'streaming' }),
      ev(2, 'tool_call_start', {
        callId: 'd1',
        toolName: 'dispatch:coder',
        args: { task: '写代码' },
        isDispatch: true,
        subStreamSessionId: 'ss-sub-9',
        subAgentName: '码农',
      }),
      ev(3, 'final', { status: 'aborted' }),
    ]);
    expect(result.status).toBe('aborted');
    const dispatch = result.segments.find((s) => s.kind === 'dispatch') as Extract<
      typeof result.segments[number],
      { kind: 'dispatch' }
    >;
    expect(dispatch.status).toBe('aborted');
    expect(result.dispatches[0]).toMatchObject({ callId: 'd1', status: 'aborted' });
  });

  it('failed 终态（崩溃收尾 final{failed}）：pending 工具收敛为 (未返回结果)', () => {
    // finalizeStreamOnCrash 崩溃路径：tool 执行中子进程退出 → final{failed}，
    // tool_call_start 无配对 result
    const result = aggregateEvents([
      ev(1, 'tool_call_start', { callId: 'c1', toolName: 'bash', args: { cmd: 'sleep 100' } }),
      ev(2, 'final', { status: 'failed', error: 'agent 运行时异常退出（exit code=1）' }),
    ]);
    const tool = result.segments.find((s) => s.kind === 'tool_call') as Extract<
      typeof result.segments[number],
      { kind: 'tool_call' }
    >;
    expect(tool.result).toBe('(未返回结果)');
    expect(tool.success).toBe(false);
    expect(result.toolCalls[0]).toMatchObject({ result: '(未返回结果)', success: false });
  });

  it('终态收敛不覆盖已配对的真实结果（正常工具不受影响）', () => {
    const result = aggregateEvents([
      ev(1, 'tool_call_start', { callId: 'c1', toolName: 'read_file', args: {} }),
      ev(2, 'tool_call_result', { callId: 'c1', result: '真实结果', success: true }),
      ev(3, 'final', { status: 'aborted' }),
    ]);
    expect(result.toolCalls[0]).toMatchObject({ result: '真实结果', success: true });
  });

  it('final 之后迟到的 tool_call_result（seq 更大）不丢失真实结果', () => {
    // 事件按 seq 升序处理：迟到的 result 在循环内正常配对，终态收敛只处理
    // 仍为 null 的段——两道防线叠加时真实结果优先
    const result = aggregateEvents([
      ev(1, 'tool_call_start', { callId: 'c1', toolName: 'read_file', args: {} }),
      ev(2, 'final', { status: 'aborted' }),
      ev(3, 'tool_call_result', { callId: 'c1', result: '迟到结果', success: true }),
    ]);
    expect(result.toolCalls[0]).toMatchObject({ result: '迟到结果', success: true });
  });

  it('流式中（无终态事件）不收敛——执行中显示保持', () => {
    const result = aggregateEvents([
      ev(1, 'tool_call_start', { callId: 'c1', toolName: 'grep', args: {} }),
      ev(2, 'tool_call_start', {
        callId: 'd1',
        toolName: 'dispatch:coder',
        args: {},
        isDispatch: true,
        subStreamSessionId: 'ss-sub-10',
        subAgentName: '码农',
      }),
    ]);
    expect(result.status).toBe('streaming');
    expect(result.toolCalls[0]!.result).toBeNull();
    expect(result.dispatches[0]!.status).toBe('executing');
  });

  it('aborted 终态：queued dispatch 同样收敛为 aborted', () => {
    // dispatch_start 事件路径（历史形状）创建的 queued 段在终态后不再停留
    const result = aggregateEvents([
      ev(1, 'dispatch_start', { callId: 'd1', subStreamSessionId: 'ss-q', subAgentName: '码农', task: '排队中' }),
      ev(2, 'final', { status: 'aborted' }),
    ]);
    expect(result.dispatches[0]!.status).toBe('aborted');
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

  it('regression（P0-6）：isDispatch 的 tool_call_start 产生 dispatch 段而非普通工具段', () => {
    const result = aggregateEvents([
      ev(1, 'text_delta', { delta: '派活' }),
      ev(2, 'tool_call_start', {
        callId: 'c1',
        toolName: 'dispatch:ui-designer',
        args: { task: '画个按钮' },
        isDispatch: true,
        subStreamSessionId: 'ss-sub-1',
        subAgentName: 'UI设计师',
        subAgentAvatar: '🎨',
      }),
      ev(3, 'tool_call_result', { callId: 'c1', result: '完成', success: true, subStatus: 'completed' }),
      ev(4, 'text_delta', { delta: '收工' }),
    ]);

    // dispatch 段（非 tool_call 段）——chip + 子流嵌套渲染的依据
    expect(result.segments.map((s) => s.kind)).toEqual(['text', 'dispatch', 'text']);
    const dispatch = result.segments[1] as Extract<typeof result.segments[1], { kind: 'dispatch' }>;
    expect(dispatch.subStreamSessionId).toBe('ss-sub-1');
    expect(dispatch.subAgentName).toBe('UI设计师');
    expect(dispatch.task).toBe('画个按钮');
    expect(dispatch.status).toBe('completed');
    // 平铺字段同步：dispatches 命中（MessageBubble 分发条件依赖）
    expect(result.dispatches).toHaveLength(1);
    // 普通 toolCalls 不含 dispatch 调用（避免双重渲染）
    expect(result.toolCalls).toHaveLength(0);
  });

  it('regression（P0-6）：dispatch result 的 subStatus=failed 映射失败状态', () => {
    const result = aggregateEvents([
      ev(1, 'tool_call_start', {
        callId: 'c1',
        toolName: 'dispatch:coder',
        args: {},
        isDispatch: true,
        subStreamSessionId: 'ss-sub-2',
        subAgentName: '码农',
      }),
      ev(2, 'tool_call_result', { callId: 'c1', result: '', success: false, subStatus: 'failed' }),
    ]);
    const dispatch = result.segments[0] as Extract<typeof result.segments[0], { kind: 'dispatch' }>;
    expect(dispatch.status).toBe('failed');
  });

  it('regression（P0-6）：dispatch 执行中（有 start 无 result）status=executing', () => {
    const result = aggregateEvents([
      ev(1, 'tool_call_start', {
        callId: 'c1',
        toolName: 'dispatch:coder',
        args: {},
        isDispatch: true,
        subStreamSessionId: 'ss-sub-3',
        subAgentName: '码农',
      }),
    ]);
    const dispatch = result.segments[0] as Extract<typeof result.segments[0], { kind: 'dispatch' }>;
    expect(dispatch.status).toBe('executing');
  });

  it('非 dispatch 的普通 tool_call 不受影响', () => {
    const result = aggregateEvents([
      ev(1, 'tool_call_start', { callId: 'c2', toolName: 'read_file', args: { path: 'a' } }),
    ]);
    expect(result.segments[0]).toMatchObject({ kind: 'tool_call', toolName: 'read_file' });
    expect(result.toolCalls).toHaveLength(1);
  });
});

// —— 以下自 renderer/tests/lib/stream-aggregator.test.ts 迁入（2026-08 目录规范统一：renderer 单测贴源存放）——
// 基础行为锁：与上方 final/终态收敛/P0-6 回归锁互补，覆盖 todo_update 全量替换、
// 乱序输入 seq 排序健壮性、空事件初始态、多 tool_call 交错配对等基础路径。
function mkEvent(
  seq: number,
  eventType: MessageEventRow['eventType'],
  payload: Record<string, unknown>,
): MessageEventRow {
  return { id: `e${seq}`, messageId: 'm1', seq, eventType, payload, createdAt: seq };
}

describe('aggregateEvents：基础行为', () => {
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
