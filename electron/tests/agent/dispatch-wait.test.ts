// electron/tests/agent/dispatch-wait.test.ts
//
// executeDispatch 会话路由测试。
// 回归锁（P0-8）：派单内部事件必须发往 PM 当前执行的会话（用户发消息的会话），
// 而非 runtime 配置的 teamSessionId——否则子 agent 消息行落在团队会话，
// 用户所在会话的 dispatch chip 反查不到子流，展开区永远为空
// （用户在普通会话中测试时复现；容器 harness sess-chat 复现实证）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeDispatch } from '../../src/main/agent/dispatch-wait';
import { INTERNAL_EVENT_MSG, type InternalEventMsg } from '../../src/main/agent/internal-event';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';

const sentEvents: InternalEventMsg[] = [];
const originalSend = process.send;

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-pm',
    agentUserId: 'agent-pm-01',
    teamSessionId: 'sess-team',
    systemPrompt: 'x',
    modelName: 'm',
    llmApiKey: 'k',
    workspaceDir: '/tmp',
    workspaceId: 'ws',
    role: 'main',
    subAgents: [{ slug: 'ui', assignmentId: 'inst-sub', description: 'UI' }],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: false,
    devMode: false,
    maxToolCalls: -1,
    ...overrides,
  };
}

describe('executeDispatch 会话路由（P0-8）', () => {
  beforeEach(() => {
    sentEvents.length = 0;
    process.send = ((msg: unknown): boolean => {
      const m = msg as InternalEventMsg;
      if (m?.type === INTERNAL_EVENT_MSG) sentEvents.push(m);
      return true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {
    process.send = originalSend;
  });

  it('dispatch 事件发往当前执行会话（executionSessionId），而非 config.teamSessionId', async () => {
    const controller = new AbortController();
    const p = executeDispatch('ui', '任务', makeConfig(), undefined, 'ss-sub', 'ss-pm', 'sess-chat', controller.signal).catch(() => null);
    controller.abort();
    await p;

    const dispatchEvt = sentEvents.find((e) => e.eventType === 'io.momo-studio.dispatch');
    expect(dispatchEvt).toBeDefined();
    expect(dispatchEvt!.sessionId).toBe('sess-chat');
    expect(dispatchEvt!.sessionId).not.toBe('sess-team');
    // P0-7 字段同步携带
    expect(dispatchEvt!.content.sub_stream_session_id).toBe('ss-sub');
    expect(dispatchEvt!.content.tool_stream_session_id).toBe('ss-pm');
  });

  it('abort_dispatch 事件同样发往当前执行会话', async () => {
    const controller = new AbortController();
    const p = executeDispatch('ui', '任务', makeConfig(), undefined, 'ss-sub', 'ss-pm', 'sess-chat', controller.signal).catch(() => null);
    controller.abort();
    await p;

    const abortEvt = sentEvents.find((e) => e.eventType === 'io.momo-studio.abort_dispatch');
    expect(abortEvt).toBeDefined();
    expect(abortEvt!.sessionId).toBe('sess-chat');
  });

  it('minor-10 回归锁：reply 到达 settle 后再触发 abort → 不再发 abort_dispatch / 无 unhandledRejection', async () => {
    const controller = new AbortController();
    const config = makeConfig({
      role: 'main',
      subAgents: [{ slug: 'worker', assignmentId: 'inst-worker', description: '执行者' }],
    });

    const p = executeDispatch('worker', '干活', config, 5, 'ss-sub', 'ss-pm', 'sess-chat', controller.signal);

    // 从 sentEvents 取 dispatch 的 task_id
    const dispatchEvt = sentEvents.find((e) => e.eventType === 'io.momo-studio.dispatch');
    expect(dispatchEvt).toBeDefined();

    // 模拟子 agent 完成 reply
    const { handleTaskReplyIpc } = await import('../../src/main/agent/dispatch-wait');
    handleTaskReplyIpc({
      type: 'task-reply',
      reply: { taskId: (dispatchEvt as { content: { task_id: string } }).content.task_id, status: 'completed', body: 'ok' },
    });
    await p; // promise 已 settle

    // settle 后再触发 abort——旧实现因 listener 未清理会再次触发 onAbort 发出
    // abort_dispatch 给不存在的子 agent
    const abortCountBefore = sentEvents.filter((e) => e.eventType === 'io.momo-studio.abort_dispatch').length;
    controller.abort();
    // 给事件循环一帧时间让（不应触发的）handler 跑完
    await new Promise((r) => setTimeout(r, 5));
    const abortCountAfter = sentEvents.filter((e) => e.eventType === 'io.momo-studio.abort_dispatch').length;
    expect(abortCountAfter).toBe(abortCountBefore); // 关键断言：settle 后不再发
  });
});
