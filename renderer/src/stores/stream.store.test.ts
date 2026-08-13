// renderer/src/stores/stream.store.test.ts
//
// stream.store 行为测试：mock window.api.agent.onStream 捕获回调，
// 模拟各类型 StreamChunk 推入，断言 StreamState 正确聚合。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StreamChunk } from '../ipc/types';
import { useStreamStore } from './stream.store';

// 收集 onStream 注册的回调，测试可主动触发
const streamCallbacks: Array<(chunk: StreamChunk) => void> = [];

// mock window.api —— ipc Proxy 在调用时读取 globalThis.window.api
vi.stubGlobal('window', {
  api: {
    agent: {
      onStream: (cb: (chunk: StreamChunk) => void) => {
        streamCallbacks.push(cb);
        return () => {};
      },
      abortStream: vi.fn().mockResolvedValue(undefined),
    },
  },
});

/** 触发已注册的 onStream 回调（推一条 chunk） */
function emit(chunk: StreamChunk): void {
  for (const cb of streamCallbacks) cb(chunk);
}

describe('stream.store', () => {
  beforeEach(() => {
    useStreamStore.setState({ streams: new Map() });
    streamCallbacks.length = 0;
  });

  it('start chunk 创建新 StreamState（streaming 状态）', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 's1', roomId: '!r1:server', botUserId: '@bot:server' });

    const streams = useStreamStore.getState().streams;
    expect(streams.size).toBe(1);
    const state = streams.get('s1');
    expect(state).toBeDefined();
    expect(state?.status).toBe('streaming');
    expect(state?.roomId).toBe('!r1:server');
    expect(state?.botUserId).toBe('@bot:server');
    expect(state?.thinking).toBe('');
    expect(state?.text).toBe('');
    expect(state?.toolCalls).toEqual([]);
  });

  it('text chunk 拼接正文', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 's1', roomId: '!r1', botUserId: '@b' });
    emit({ type: 'text', streamSessionId: 's1', delta: 'Hello' });
    emit({ type: 'text', streamSessionId: 's1', delta: ' world' });

    const state = useStreamStore.getState().streams.get('s1');
    expect(state?.text).toBe('Hello world');
  });

  it('thinking chunk 拼接思考过程', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 's1', roomId: '!r1', botUserId: '@b' });
    emit({ type: 'thinking', streamSessionId: 's1', delta: '分析' });
    emit({ type: 'thinking', streamSessionId: 's1', delta: '中' });

    const state = useStreamStore.getState().streams.get('s1');
    expect(state?.thinking).toBe('分析中');
  });

  it('tool_call chunk 追加到 toolCalls 列表（isExecuting=true）', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 's1', roomId: '!r1', botUserId: '@b' });
    emit({
      type: 'tool_call',
      callId: 'test-call-1',
      streamSessionId: 's1',
      toolName: 'read_file',
      args: { path: 'a.ts' },
    });

    const state = useStreamStore.getState().streams.get('s1');
    expect(state?.toolCalls).toHaveLength(1);
    expect(state?.toolCalls[0]?.toolName).toBe('read_file');
    expect(state?.toolCalls[0]?.args).toEqual({ path: 'a.ts' });
    expect(state?.toolCalls[0]?.isExecuting).toBe(true);
  });

  it('tool_result chunk 更新匹配的执行中工具（成功）', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 's1', roomId: '!r1', botUserId: '@b' });
    emit({ type: 'tool_call', callId: 'inline-call', streamSessionId: 's1', toolName: 'read_file', args: { path: 'a' } });
    emit({
      type: 'tool_result',
      callId: 'test-result-1',
      streamSessionId: 's1',
      toolName: 'read_file',
      result: 'file content',
      success: true,
    });

    const tc = useStreamStore.getState().streams.get('s1')?.toolCalls[0];
    expect(tc?.result).toBe('file content');
    expect(tc?.success).toBe(true);
    expect(tc?.isExecuting).toBe(false);
  });

  it('tool_result 匹配最后一个执行中的同名工具（多次同名调用）', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 's1', roomId: '!r1', botUserId: '@b' });
    emit({ type: 'tool_call', callId: 'inline-call', streamSessionId: 's1', toolName: 'grep', args: { q: '1' } });
    emit({ type: 'tool_call', callId: 'inline-call', streamSessionId: 's1', toolName: 'grep', args: { q: '2' } });
    emit({ type: 'tool_result', callId: 'inline-result', streamSessionId: 's1', toolName: 'grep', result: 'r2', success: true });

    const calls = useStreamStore.getState().streams.get('s1')?.toolCalls;
    expect(calls?.[0]?.isExecuting).toBe(true); // 第一个仍在执行
    expect(calls?.[1]?.result).toBe('r2'); // 第二个被更新
    expect(calls?.[1]?.isExecuting).toBe(false);
  });

  it('end(stop) chunk 设置 status=done 并保留正文', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 's1', roomId: '!r1', botUserId: '@b' });
    emit({ type: 'text', streamSessionId: 's1', delta: '回复' });
    emit({ type: 'end', streamSessionId: 's1', finishReason: 'stop' });

    const state = useStreamStore.getState().streams.get('s1');
    expect(state?.status).toBe('done');
    expect(state?.text).toBe('回复');
  });

  it('end(interrupted) chunk 设置 status=interrupted', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 's1', roomId: '!r1', botUserId: '@b' });
    emit({ type: 'end', streamSessionId: 's1', finishReason: 'interrupted' });

    expect(useStreamStore.getState().streams.get('s1')?.status).toBe('interrupted');
  });

  it('end(error) chunk 设置 status=error 并记录 error 文本', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 's1', roomId: '!r1', botUserId: '@b' });
    emit({ type: 'end', streamSessionId: 's1', finishReason: 'error', error: 'boom' });

    const state = useStreamStore.getState().streams.get('s1');
    expect(state?.status).toBe('error');
    expect(state?.error).toBe('boom');
  });

  it('未知 streamSessionId 的 chunk 被安全忽略', () => {
    useStreamStore.getState().init();
    emit({ type: 'text', streamSessionId: 'unknown', delta: 'x' });
    expect(useStreamStore.getState().streams.size).toBe(0);
  });

  it('init 返回取消订阅函数', () => {
    const unsubscribe = useStreamStore.getState().init();
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });

  it('clearCompleted 删除指定 session', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 's1', roomId: '!r1', botUserId: '@b' });
    emit({ type: 'start', streamSessionId: 's2', roomId: '!r2', botUserId: '@b' });

    useStreamStore.getState().clearCompleted('s1');
    const streams = useStreamStore.getState().streams;
    expect(streams.has('s1')).toBe(false);
    expect(streams.has('s2')).toBe(true);
  });
});

// ───────────────────────── v1.4 嵌套 dispatch ─────────────────────────

describe('stream.store — v1.4 嵌套 dispatch', () => {
  beforeEach(() => {
    useStreamStore.setState({ streams: new Map() });
    streamCallbacks.length = 0;
  });

  it('tool_call(isDispatch) 在父 stream 登记一个 status=queued 的 dispatchChild（不混入 toolCalls）', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 'pm1', roomId: '!r', botUserId: '@pm' });
    emit({
      type: 'tool_call',
      callId: 'test-call-2',
      streamSessionId: 'pm1',
      toolName: 'dispatch:coder',
      args: { task: '写代码' },
      isDispatch: true,
      subStreamSessionId: 'sub1',
      subAgentName: 'Coder',
      subAgentAvatar: '🤖',
    });

    const pm = useStreamStore.getState().streams.get('pm1');
    expect(pm?.toolCalls).toHaveLength(0); // dispatch 不混入普通 toolCalls
    expect(pm?.dispatchChildren).toHaveLength(1);
    const child = pm?.dispatchChildren[0];
    expect(child?.subStreamSessionId).toBe('sub1');
    expect(child?.subAgentName).toBe('Coder');
    expect(child?.subAgentAvatar).toBe('🤖');
    expect(child?.status).toBe('queued');
  });

  it('普通 tool_call（无 isDispatch）仍走 toolCalls 分支，不影响 dispatchChildren', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 'pm1', roomId: '!r', botUserId: '@pm' });
    emit({ type: 'tool_call', callId: 'inline-call', streamSessionId: 'pm1', toolName: 'read_file', args: {} });

    const pm = useStreamStore.getState().streams.get('pm1');
    expect(pm?.toolCalls).toHaveLength(1);
    expect(pm?.dispatchChildren).toHaveLength(0);
  });

  it('start(parentStreamSessionId) 创建子 stream 并把父的对应 DispatchChild 置为 executing', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 'pm1', roomId: '!r', botUserId: '@pm' });
    emit({
      type: 'tool_call',
      callId: 'test-call-3',
      streamSessionId: 'pm1',
      toolName: 'dispatch:coder',
      args: {},
      isDispatch: true,
      subStreamSessionId: 'sub1',
      subAgentName: 'Coder',
    });
    emit({
      type: 'start',
      streamSessionId: 'sub1',
      roomId: '!r',
      botUserId: '@sub',
      parentStreamSessionId: 'pm1',
      subAgentName: 'Coder',
    });

    const sub = useStreamStore.getState().streams.get('sub1');
    expect(sub).toBeDefined();
    expect(sub?.parentStreamSessionId).toBe('pm1');
    expect(sub?.dispatchChildren).toEqual([]);

    const pm = useStreamStore.getState().streams.get('pm1');
    expect(pm?.dispatchChildren[0]?.status).toBe('executing');
  });

  it('tool_result(subStatus=completed) 把最后一个未终结 DispatchChild 置为 completed', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 'pm1', roomId: '!r', botUserId: '@pm' });
    emit({
      type: 'tool_call',
      callId: 'test-call-4',
      streamSessionId: 'pm1',
      toolName: 'dispatch:coder',
      args: {},
      isDispatch: true,
      subStreamSessionId: 'sub1',
      subAgentName: 'Coder',
    });
    emit({
      type: 'tool_result',
      callId: 'test-result-2',
      streamSessionId: 'pm1',
      toolName: 'dispatch:coder',
      result: '完成',
      success: true,
      subStatus: 'completed',
    });

    expect(useStreamStore.getState().streams.get('pm1')?.dispatchChildren[0]?.status).toBe(
      'completed',
    );
  });

  it('tool_result(subStatus=failed/timeout) 把对应 DispatchChild 置为 failed', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 'pm1', roomId: '!r', botUserId: '@pm' });
    emit({
      type: 'tool_call',
      callId: 'test-call-5',
      streamSessionId: 'pm1',
      toolName: 'dispatch:coder',
      args: {},
      isDispatch: true,
      subStreamSessionId: 'sub1',
      subAgentName: 'Coder',
    });
    emit({
      type: 'tool_result',
      callId: 'test-result-3',
      streamSessionId: 'pm1',
      toolName: 'dispatch:coder',
      result: '超时',
      success: false,
      subStatus: 'timeout',
    });

    expect(useStreamStore.getState().streams.get('pm1')?.dispatchChildren[0]?.status).toBe(
      'failed',
    );
  });

  it('子 agent end(stop) 把父的对应 DispatchChild 置为 completed，子 stream 自身 status=done', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 'pm1', roomId: '!r', botUserId: '@pm' });
    emit({
      type: 'tool_call',
      callId: 'test-call-6',
      streamSessionId: 'pm1',
      toolName: 'dispatch:coder',
      args: {},
      isDispatch: true,
      subStreamSessionId: 'sub1',
      subAgentName: 'Coder',
    });
    emit({
      type: 'start',
      streamSessionId: 'sub1',
      roomId: '!r',
      botUserId: '@sub',
      parentStreamSessionId: 'pm1',
    });
    emit({ type: 'end', streamSessionId: 'sub1', finishReason: 'stop' });

    const sub = useStreamStore.getState().streams.get('sub1');
    expect(sub?.status).toBe('done');
    expect(sub?.finishReason).toBe('stop');
    expect(useStreamStore.getState().streams.get('pm1')?.dispatchChildren[0]?.status).toBe(
      'completed',
    );
  });

  it('子 agent end(error) 把父的对应 DispatchChild 置为 failed', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 'pm1', roomId: '!r', botUserId: '@pm' });
    emit({
      type: 'tool_call',
      callId: 'test-call-7',
      streamSessionId: 'pm1',
      toolName: 'dispatch:coder',
      args: {},
      isDispatch: true,
      subStreamSessionId: 'sub1',
      subAgentName: 'Coder',
    });
    emit({
      type: 'start',
      streamSessionId: 'sub1',
      roomId: '!r',
      botUserId: '@sub',
      parentStreamSessionId: 'pm1',
    });
    emit({ type: 'end', streamSessionId: 'sub1', finishReason: 'error', error: '崩溃' });

    expect(useStreamStore.getState().streams.get('pm1')?.dispatchChildren[0]?.status).toBe(
      'failed',
    );
  });

  it('子 agent end(budget_exhausted) 视为 completed', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 'pm1', roomId: '!r', botUserId: '@pm' });
    emit({
      type: 'tool_call',
      callId: 'test-call-8',
      streamSessionId: 'pm1',
      toolName: 'dispatch:coder',
      args: {},
      isDispatch: true,
      subStreamSessionId: 'sub1',
      subAgentName: 'Coder',
    });
    emit({
      type: 'start',
      streamSessionId: 'sub1',
      roomId: '!r',
      botUserId: '@sub',
      parentStreamSessionId: 'pm1',
    });
    emit({ type: 'end', streamSessionId: 'sub1', finishReason: 'budget_exhausted' });

    expect(useStreamStore.getState().streams.get('pm1')?.dispatchChildren[0]?.status).toBe(
      'completed',
    );
  });

  it('子 stream 的常规 chunk（thinking/text/tool_call/tool_result）正常更新子 StreamState', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 'pm1', roomId: '!r', botUserId: '@pm' });
    emit({
      type: 'tool_call',
      callId: 'test-call-9',
      streamSessionId: 'pm1',
      toolName: 'dispatch:coder',
      args: {},
      isDispatch: true,
      subStreamSessionId: 'sub1',
      subAgentName: 'Coder',
    });
    emit({
      type: 'start',
      streamSessionId: 'sub1',
      roomId: '!r',
      botUserId: '@sub',
      parentStreamSessionId: 'pm1',
    });
    emit({ type: 'thinking', streamSessionId: 'sub1', delta: '思考' });
    emit({ type: 'text', streamSessionId: 'sub1', delta: '回复' });
    emit({ type: 'tool_call', callId: 'inline-call', streamSessionId: 'sub1', toolName: 'read_file', args: { p: 'a' } });
    emit({
      type: 'tool_result',
      callId: 'test-result-4',
      streamSessionId: 'sub1',
      toolName: 'read_file',
      result: '内容',
      success: true,
    });

    const sub = useStreamStore.getState().streams.get('sub1');
    expect(sub?.thinking).toBe('思考');
    expect(sub?.text).toBe('回复');
    expect(sub?.toolCalls).toHaveLength(1);
    expect(sub?.toolCalls[0]?.toolName).toBe('read_file');
    expect(sub?.toolCalls[0]?.result).toBe('内容');
    expect(sub?.toolCalls[0]?.isExecuting).toBe(false);
  });

  it('多个并行 dispatch 各自独立登记为 dispatchChildren', () => {
    useStreamStore.getState().init();
    emit({ type: 'start', streamSessionId: 'pm1', roomId: '!r', botUserId: '@pm' });
    emit({
      type: 'tool_call',
      callId: 'test-call-10',
      streamSessionId: 'pm1',
      toolName: 'dispatch:coder',
      args: {},
      isDispatch: true,
      subStreamSessionId: 'sub1',
      subAgentName: 'Coder',
    });
    emit({
      type: 'tool_call',
      callId: 'test-call-11',
      streamSessionId: 'pm1',
      toolName: 'dispatch:reviewer',
      args: {},
      isDispatch: true,
      subStreamSessionId: 'sub2',
      subAgentName: 'Reviewer',
    });

    const pm = useStreamStore.getState().streams.get('pm1');
    expect(pm?.dispatchChildren).toHaveLength(2);
    expect(pm?.dispatchChildren[0]?.subStreamSessionId).toBe('sub1');
    expect(pm?.dispatchChildren[0]?.status).toBe('queued');
    expect(pm?.dispatchChildren[1]?.subStreamSessionId).toBe('sub2');
    expect(pm?.dispatchChildren[1]?.status).toBe('queued');
  });
});
