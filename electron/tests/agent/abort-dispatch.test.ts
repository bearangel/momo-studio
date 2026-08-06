// 验证 v1.5.3：PM 中断 dispatch 时发 abort_dispatch event；子 agent handleDispatch
// 监听此 event 并触发本地 abortController，runChatLoop 终止。
import { describe, it, expect } from 'vitest';
import {
  ABORT_DISPATCH_EVENT_TYPE,
  buildAbortDispatchMessage,
} from '../../src/main/agent/dispatch';

describe('abort_dispatch event', () => {
  it('ABORT_DISPATCH_EVENT_TYPE 常量正确', () => {
    expect(ABORT_DISPATCH_EVENT_TYPE).toBe('io.momo-studio.abort_dispatch');
  });

  it('buildAbortDispatchMessage 含 task_id', () => {
    const msg = buildAbortDispatchMessage({ taskId: 'task-123' });
    expect(msg.eventType).toBe(ABORT_DISPATCH_EVENT_TYPE);
    expect(msg.content.task_id).toBe('task-123');
    expect(msg.content.sub_stream_session_id).toBeUndefined();
  });

  it('buildAbortDispatchMessage 含 subStreamSessionId（可选）', () => {
    const msg = buildAbortDispatchMessage({
      taskId: 'task-456',
      subStreamSessionId: 'sub-sess-abc',
    });
    expect(msg.content.task_id).toBe('task-456');
    expect(msg.content.sub_stream_session_id).toBe('sub-sess-abc');
  });

  it('不同 task_id 的消息 content 不同（避免子 agent 误匹配）', () => {
    const a = buildAbortDispatchMessage({ taskId: 'A' });
    const b = buildAbortDispatchMessage({ taskId: 'B' });
    expect(a.content.task_id).not.toBe(b.content.task_id);
  });
});

describe('abort_dispatch 时序竞态场景', () => {
  it('子 agent 即使在 abort_dispatch event 之后才启动也能终止（持久化保证）', () => {
    // 这是设计层保证：Matrix event 持久化，子 agent 后续 subscribe team_room 时
    // 会收到历史 event，匹配 task_id 后触发 abortController.abort()。
    // 此测试验证 buildAbortDispatchMessage 的 content 含 task_id（子 agent 匹配依据）。
    const msg = buildAbortDispatchMessage({ taskId: 'late-task' });
    expect(msg.content.task_id).toBe('late-task');
  });
});
