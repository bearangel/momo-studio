// electron/tests/agent/dispatch.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildDispatchMessage,
  buildTaskReply,
  parseDispatchEvent,
  parseTaskReply,
  DISPATCH_EVENT_TYPE,
  TASK_REPLY_EVENT_TYPE,
} from '../../src/main/agent/dispatch';

describe('agent/dispatch', () => {
  it('buildDispatchMessage 生成正确的 event type + content', () => {
    const msg = buildDispatchMessage({
      body: '帮我写需求文档',
      fromAssignmentId: 'inst-pm',
      toAssignmentId: 'inst-req',
    });
    expect(msg.eventType).toBe(DISPATCH_EVENT_TYPE);
    expect(msg.content.body).toBe('帮我写需求文档');
    expect(msg.content.dispatch_from).toBe('inst-pm');
    expect(msg.content.dispatch_to).toBe('inst-req');
    expect(msg.content.task_id).toHaveLength(36); // UUID
  });

  it('parseDispatchEvent 正确解析', () => {
    const parsed = parseDispatchEvent({
      body: 'test',
      task_id: 'abc-123',
      dispatch_from: 'inst-a',
      dispatch_to: 'inst-b',
    });
    expect(parsed?.task_id).toBe('abc-123');
    expect(parsed?.dispatch_to).toBe('inst-b');
  });

  it('parseDispatchEvent 缺字段返回 null', () => {
    expect(parseDispatchEvent({ body: 'test' })).toBeNull();
  });

  it('minor-9 回归锁：parseDispatchEvent 缺 dispatch_from/dispatch_to → null（防 undefined key 路由）', () => {
    expect(parseDispatchEvent({ body: 'x', task_id: 't', dispatch_to: 'a' })).toBeNull();
    expect(parseDispatchEvent({ body: 'x', task_id: 't', dispatch_from: 'a' })).toBeNull();
  });

  it('minor-9 回归锁：parseDispatchEvent 可选字段类型不符 → 丢弃该字段（不连带拒整条）', () => {
    const parsed = parseDispatchEvent({
      body: 'x',
      task_id: 't',
      dispatch_from: 'a',
      dispatch_to: 'b',
      deadline_ms: 'oops',        // 应被忽略
      tool_budget: true,          // 应被忽略
      sub_stream_session_id: 42,  // 应被忽略
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.deadline_ms).toBeUndefined();
    expect(parsed!.tool_budget).toBeUndefined();
    expect(parsed!.sub_stream_session_id).toBeUndefined();
  });

  it('minor-9 回归锁：parseTaskReply status 非合法枚举 → null', () => {
    expect(parseTaskReply({ body: 'x', task_id: 't', status: 'success' })).toBeNull();
    expect(parseTaskReply({ body: 'x', task_id: 't', status: 'done' })).toBeNull();
    expect(parseTaskReply({ body: 'x', task_id: 't' })).toBeNull();
    expect(parseTaskReply({ body: 'x', task_id: 't', status: 200 })).toBeNull();
  });

  it('minor-9 回归锁：parseTaskReply status 合法值通过', () => {
    expect(parseTaskReply({ body: 'x', task_id: 't', status: 'in_progress' })?.status).toBe('in_progress');
    expect(parseTaskReply({ body: 'x', task_id: 't', status: 'completed' })?.status).toBe('completed');
    expect(parseTaskReply({ body: 'x', task_id: 't', status: 'needs_input' })?.status).toBe('needs_input');
  });

  it('regression（P0-7）：dispatch 消息携带 sub_stream_session_id（子 agent 自身流 id）与 tool_stream_session_id（PM 流 id）双字段', () => {
    const msg = buildDispatchMessage({
      body: '画个按钮',
      fromAssignmentId: 'inst-pm',
      toAssignmentId: 'inst-ui',
      subStreamSessionId: 'ss-sub-abc',
      toolStreamSessionId: 'ss-pm-xyz',
    });
    // sub_stream_session_id：子 agent 自身流 id——routeDispatch 用它作 task.streamSessionId
    expect(msg.content.sub_stream_session_id).toBe('ss-sub-abc');
    // tool_stream_session_id：PM 自身流 id——子消息 parentStreamSessionId 的来源
    expect(msg.content.tool_stream_session_id).toBe('ss-pm-xyz');

    const parsed = parseDispatchEvent({ ...msg.content });
    expect(parsed?.sub_stream_session_id).toBe('ss-sub-abc');
    expect(parsed?.tool_stream_session_id).toBe('ss-pm-xyz');
  });

  it('buildTaskReply + parseTaskReply 往返', () => {
    const reply = buildTaskReply({
      body: '完成了',
      taskId: 'task-xyz',
      status: 'completed',
    });
    expect(reply.eventType).toBe(TASK_REPLY_EVENT_TYPE);
    const parsed = parseTaskReply(reply.content);
    expect(parsed?.status).toBe('completed');
    expect(parsed?.task_id).toBe('task-xyz');
  });

  // minor-9 回归锁：parseDispatchEvent 必须严格校验 dispatch_from / dispatch_to，
  // 缺字段或类型错（null / number / undefined）→ 返回 null，避免下游把
  // undefined 当 runner Map key 查找静默丢弃。
  describe('minor-9 parse 严格校验', () => {
    it('parseDispatchEvent：dispatch_from 缺/类型错 → null', () => {
      // 缺字段
      expect(parseDispatchEvent({ body: 'x', task_id: 't1', dispatch_to: 'b' })).toBeNull();
      // 类型错（number / null）
      expect(parseDispatchEvent({ body: 'x', task_id: 't1', dispatch_from: 123, dispatch_to: 'b' })).toBeNull();
      expect(parseDispatchEvent({ body: 'x', task_id: 't1', dispatch_from: null, dispatch_to: 'b' })).toBeNull();
    });
    it('parseDispatchEvent：dispatch_to 缺/类型错 → null', () => {
      expect(parseDispatchEvent({ body: 'x', task_id: 't1', dispatch_from: 'a' })).toBeNull();
      expect(parseDispatchEvent({ body: 'x', task_id: 't1', dispatch_from: 'a', dispatch_to: 456 })).toBeNull();
    });
    it('parseDispatchEvent：可选字段类型错时被剥离但不连带拒绝', () => {
      // deadline_ms 错为 string → 解析成功但 deadline_ms 缺失
      const parsed = parseDispatchEvent({
        body: 'x', task_id: 't1', dispatch_from: 'a', dispatch_to: 'b',
        deadline_ms: 'oops', tool_budget: -1, tool_stream_session_id: 99,
      });
      expect(parsed).not.toBeNull();
      expect(parsed?.deadline_ms).toBeUndefined();
      expect(parsed?.tool_budget).toBe(-1); // number 保留
      expect(parsed?.tool_stream_session_id).toBeUndefined(); // 99 非 string 剥离
    });
    it('parseTaskReply：status 缺失/类型错/非法枚举 → null', () => {
      // 缺 status
      expect(parseTaskReply({ task_id: 't', body: 'x' })).toBeNull();
      // status 非 string
      expect(parseTaskReply({ task_id: 't', body: 'x', status: 123 })).toBeNull();
      // status 是合法字符串但不在枚举内（旧实现 as-cast 静默接受，minor-9 拦截）
      expect(parseTaskReply({ task_id: 't', body: 'x', status: 'success' })).toBeNull();
      expect(parseTaskReply({ task_id: 't', body: 'x', status: 'done' })).toBeNull();
      expect(parseTaskReply({ task_id: 't', body: 'x', status: 'canceled' /* 单 l */ })).toBeNull();
    });
    it('parseTaskReply：合法枚举值全部通过', () => {
      for (const status of ['in_progress', 'completed', 'failed', 'needs_input'] as const) {
        expect(parseTaskReply({ task_id: 't', body: 'x', status })).not.toBeNull();
      }
    });
    it('parseTaskReply：可选字段类型错时被剥离但不连带拒绝', () => {
      const parsed = parseTaskReply({
        task_id: 't', body: 'x', status: 'completed',
        progress_pct: '90%', tool_calls_used: '5', reply_to: 123,
      });
      expect(parsed).not.toBeNull();
      expect(parsed?.progress_pct).toBeUndefined();
      expect(parsed?.tool_calls_used).toBeUndefined();
      expect(parsed?.reply_to).toBeUndefined();
    });
  });
});