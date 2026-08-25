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
});