// 导出富信息聚合器单测（v2.3.2 spec §4）：时间线交错、跳过 thinking、
// callId 配对、isDispatch 分流、终态收敛、todo 位置快照、畸形事件防御。
import { describe, it, expect } from 'vitest';
import { exportAggregateEvents } from '../../src/main/im/export-aggregator';
import type { MessageEventRow } from '../../src/main/storage/messages/events-repo';

let seq = 0;
function ev(eventType: MessageEventRow['eventType'], payload: Record<string, unknown>): MessageEventRow {
  seq += 1;
  return { id: `e-${seq}`, messageId: 'm-1', seq, eventType, payload, createdAt: seq };
}

describe('exportAggregateEvents', () => {
  it('text 聚合为相邻段、thinking 完全排除', () => {
    const r = exportAggregateEvents([
      ev('thinking_delta', { delta: '内心独白' }),
      ev('text_delta', { delta: '先看' }),
      ev('text_delta', { delta: '目录' }),
      ev('final', { status: 'done' }),
    ]);
    expect(r.segments).toEqual([{ kind: 'text', text: '先看目录' }]);
    expect(r.status).toBe('done');
    expect(JSON.stringify(r.segments)).not.toContain('内心独白');
  });

  it('F3：text 段剥离 <secrecy> 隐藏上下文（含跨 delta 拆分的块）', () => {
    const r = exportAggregateEvents([
      ev('text_delta', { delta: '正文。<sec' }),
      ev('text_delta', { delta: 'recy>私有规划' }),
      ev('text_delta', { delta: '不外泄</secrecy>' }),
      ev('text_delta', { delta: '收尾。' }),
      ev('final', { status: 'done' }),
    ]);
    expect(r.segments).toEqual([{ kind: 'text', text: '正文。收尾。' }]);
  });

  it('tool start/result 按 callId 配对（含 args/result/success）', () => {
    const r = exportAggregateEvents([
      ev('text_delta', { delta: '查一下' }),
      ev('tool_call_start', { callId: 'c1', toolName: 'list_files', args: { path: '/src' } }),
      ev('tool_call_result', { callId: 'c1', result: 'a.ts', success: true }),
      ev('final', { status: 'done' }),
    ]);
    expect(r.segments).toEqual([
      { kind: 'text', text: '查一下' },
      { kind: 'tool', callId: 'c1', toolName: 'list_files', args: { path: '/src' }, result: 'a.ts', success: true },
    ]);
  });

  it('终态后未配对 tool：done → (未返回结果)；aborted → (已中断)', () => {
    const r1 = exportAggregateEvents([
      ev('tool_call_start', { callId: 'c1', toolName: 'grep', args: {} }),
      ev('final', { status: 'done' }),
    ]);
    expect(r1.segments[0]).toMatchObject({ kind: 'tool', result: '(未返回结果)', success: false });
    const r2 = exportAggregateEvents([
      ev('tool_call_start', { callId: 'c1', toolName: 'grep', args: {} }),
      ev('final', { status: 'aborted' }),
    ]);
    expect(r2.segments[0]).toMatchObject({ result: '(已中断)' });
  });

  it('isDispatch 分流为 dispatch 段，subStatus 回执更新终态', () => {
    const r = exportAggregateEvents([
      ev('tool_call_start', { callId: 'd1', toolName: 'dispatch:tester', isDispatch: true, subStreamSessionId: 'ss-sub', subAgentName: 'tester', args: { task: '验证' } }),
      ev('tool_call_result', { callId: 'd1', subStatus: 'completed' }),
      ev('final', { status: 'done' }),
    ]);
    expect(r.segments).toEqual([
      { kind: 'dispatch', callId: 'd1', toolName: 'dispatch:tester', subStreamSessionId: 'ss-sub', subAgentName: 'tester', task: '验证', status: 'completed' },
    ]);
  });

  it('dispatch 终态后无回执收敛为 aborted（镜像 UI 防永久执行中；同步 dispatch 保持旧语义）', () => {
    const r = exportAggregateEvents([
      ev('tool_call_start', { callId: 'd1', toolName: 'dispatch:coder', isDispatch: true, subStreamSessionId: 'ss-sub', subAgentName: 't', args: {} }),
      ev('final', { status: 'aborted' }),
    ]);
    expect(r.segments[0]).toMatchObject({ kind: 'dispatch', status: 'aborted' });
  });

  it('F2：dispatch_bg 流终态仍未收割 → 收敛为 delegated（诚实展示已派出，不误判中断）', () => {
    const r = exportAggregateEvents([
      ev('tool_call_start', { callId: 'b1', toolName: 'dispatch_bg:coder', isDispatch: true, subStreamSessionId: 'ss-bg', subAgentName: '码农', args: { task: '后台' } }),
      ev('final', { status: 'done' }),
    ]);
    expect(r.segments[0]).toMatchObject({ kind: 'dispatch', status: 'delegated', toolName: 'dispatch_bg:coder' });
  });

  it('F2：gather 回链 patch（tool_result subStatus）把 bg 委派翻为真实终态，不再被收敛覆盖', () => {
    const r = exportAggregateEvents([
      ev('tool_call_start', { callId: 'b1', toolName: 'dispatch_bg:coder', isDispatch: true, subStreamSessionId: 'ss-bg', subAgentName: '码农', args: {} }),
      ev('tool_call_start', { callId: 'g1', toolName: 'dispatch_gather', args: { handles: ['b1'] } }),
      ev('tool_call_result', { callId: 'g1', result: '{"done":[]}', success: true }),
      ev('tool_call_result', { callId: 'b1', result: '后台任务完成', success: true, subStatus: 'completed' }),
      ev('final', { status: 'done' }),
    ]);
    const dispatch = r.segments.find((s) => s.kind === 'dispatch');
    expect(dispatch).toMatchObject({ callId: 'b1', status: 'completed' });
  });

  it('F2：subStatus=failed 的回链 patch → dispatch 段 failed（失败不被显示为完成）', () => {
    const r = exportAggregateEvents([
      ev('tool_call_start', { callId: 'b1', toolName: 'dispatch_bg:coder', isDispatch: true, subStreamSessionId: 'ss-bg', subAgentName: '码农', args: {} }),
      ev('tool_call_result', { callId: 'b1', result: '后台任务失败', success: false, subStatus: 'failed' }),
      ev('final', { status: 'done' }),
    ]);
    expect(r.segments[0]).toMatchObject({ kind: 'dispatch', status: 'failed' });
  });

  it('todo_update 每次一个位置快照段（非末值胜出）', () => {
    const r = exportAggregateEvents([
      ev('todo_update', { todos: [{ id: '1', subject: 'A', status: 'pending' }] }),
      ev('text_delta', { delta: '做 A' }),
      ev('todo_update', { todos: [{ id: '1', subject: 'A', status: 'completed' }] }),
      ev('final', { status: 'done' }),
    ]);
    expect(r.segments[0]).toMatchObject({ kind: 'todo', items: [{ status: 'pending' }] });
    expect(r.segments[2]).toMatchObject({ kind: 'todo', items: [{ status: 'completed' }] });
  });

  it('final 携带 error 时捕获（status=failed）', () => {
    const r = exportAggregateEvents([
      ev('text_delta', { delta: 'x' }),
      ev('final', { status: 'failed', error: 'provider 429' }),
    ]);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('provider 429');
  });

  it('畸形事件跳过不炸（缺 callId / delta 非字符串）', () => {
    const r = exportAggregateEvents([
      ev('text_delta', { delta: 123 }),
      ev('tool_call_start', { toolName: 'x' }),
      ev('tool_call_result', { result: 'y' }),
      ev('final', { status: 'done' }),
    ]);
    expect(r.segments).toEqual([]);
    expect(r.status).toBe('done');
  });
});
