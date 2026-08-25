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
    isCoordinator: false,
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
});
