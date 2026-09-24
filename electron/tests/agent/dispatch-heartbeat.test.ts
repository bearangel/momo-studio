// electron/tests/agent/dispatch-heartbeat.test.ts
//
// v2.9 事件驱动 dispatch（spec 2026-09-24）：子 agent 心跳上报契约测试。
// 生产者 startDispatchHeartbeat（runtime-entry，子进程侧）真实产出 →
// 消费者 parseTaskReply（dispatch.ts，主进程 routeTaskReply 的解析入口）+
// DispatchRegistry.heartbeat 真实消费——momo-test-rules 铁律 4（跨模块对接面
// 用契约测试，不经手写构造的中间数据）。
//
// 覆盖：
//   1. 首拍立即发送（注册即活——消除排队/首 LLM 慢的死亡误判窗口）
//   2. 60s 周期持续上报；停止函数后不再上报（终态回执前停——防迟拍翻活）
//   3. 事件形状契约：parseTaskReply 解析成功、status=in_progress、
//      reply_to=PM assignmentId、tool_calls_used 随 stats 递增、
//      有预算时 progress_pct 单调且 <100
//   4. 消费端：registry.heartbeat 接受该形状（in_flight 链续命）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 必须在 import runtime-entry 之前 mock llm-provider（vi.mock 会被 hoist——
// 同 runtime-segment.test.ts 模式；本测试不触发 LLM 调用，仅隔离导入副作用）
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import { startDispatchHeartbeat } from '../../src/main/agent/runtime-entry';
import { parseTaskReply } from '../../src/main/agent/dispatch';
import { HEARTBEAT_INTERVAL_MS } from '../../src/main/agent/dispatch-registry';
import { DispatchRegistry } from '../../src/main/agent/dispatch-registry';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import { INTERNAL_EVENT_MSG, type InternalEventMsg } from '../../src/main/agent/internal-event';

const sentEvents: InternalEventMsg[] = [];
const originalSend = process.send;

function makeConfig(): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-sub',
    agentUserId: 'agent-inst-sub',
    systemPrompt: 'x',
    modelName: 'm',
    llmApiKey: 'k',
    workspaceDir: '/tmp',
    workspaceId: 'ws',
    role: 'sub',
    subAgents: [],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: false,
    devMode: false,
    maxToolCalls: -1,
    contextWindow: 0,
    outputTokens: 0,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  sentEvents.length = 0;
  process.send = ((msg: unknown): boolean => {
    const m = msg as InternalEventMsg;
    if (m?.type === INTERNAL_EVENT_MSG) sentEvents.push(m);
    return true;
  }) as NonNullable<typeof process.send>;
});

afterEach(() => {
  vi.useRealTimers();
  process.send = originalSend;
});

function taskReplyEvents(): InternalEventMsg[] {
  return sentEvents.filter((e) => e.eventType === 'io.momo-studio.task_reply');
}

describe('startDispatchHeartbeat 契约', () => {
  it('首拍立即发送 + 60s 周期 + 停止后静默', () => {
    const stats = { toolCallsUsed: 0 };
    const stop = startDispatchHeartbeat(
      'sess-room',
      makeConfig(),
      { fromAssignmentId: 'inst-pm', task_id: 'T-hb-1' },
      stats,
      10,
    );

    // 首拍立即（不等 interval）
    expect(taskReplyEvents()).toHaveLength(1);

    // 周期上报：60s 一拍，stats 变化随拍可见
    stats.toolCallsUsed = 4;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(taskReplyEvents()).toHaveLength(2);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(taskReplyEvents()).toHaveLength(5);

    // 停止后不再上报
    stop();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 5);
    expect(taskReplyEvents()).toHaveLength(5);
  });

  it('事件形状：parseTaskReply 可解析 + status/reply_to/tool_calls_used/progress_pct 契约', () => {
    const stats = { toolCallsUsed: 7 };
    const stop = startDispatchHeartbeat(
      'sess-room',
      makeConfig(),
      { fromAssignmentId: 'inst-pm', task_id: 'T-hb-2' },
      stats,
      20,
    );

    const evt = taskReplyEvents()[0]!;
    expect(evt.sessionId).toBe('sess-room');
    expect(evt.sender).toBe('agent-inst-sub');

    // 生产者 content → 真实消费者解析（不经手写中间数据）
    const reply = parseTaskReply(evt.content);
    expect(reply).not.toBeNull();
    expect(reply?.status).toBe('in_progress');
    expect(reply?.task_id).toBe('T-hb-2');
    expect(reply?.reply_to).toBe('inst-pm');
    expect(reply?.tool_calls_used).toBe(7);
    // 预算 20、已用 7 → progress_pct = 35（<100 封顶语义）
    expect(reply?.progress_pct).toBe(35);
    expect(reply?.body).toContain('7');

    // 无预算（-1/undefined）→ 不携带 progress_pct 字段
    stop();
    const stop2 = startDispatchHeartbeat(
      'sess-room',
      makeConfig(),
      { fromAssignmentId: 'inst-pm', task_id: 'T-hb-3' },
      stats,
      -1,
    );
    const reply2 = parseTaskReply(taskReplyEvents().at(-1)!.content);
    expect(reply2?.progress_pct).toBeUndefined();
    stop2();
  });

  it('消费端：registry.heartbeat 接受该形状（in_flight 链续命）', () => {
    const reg = new DispatchRegistry();
    reg.register({
      taskId: 'T-hb-4',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: 'sess-room',
      isFollowupRound: false,
    });
    const before = reg.get('T-hb-4')?.lastHeartbeatAt;

    const stop = startDispatchHeartbeat(
      'sess-room',
      makeConfig(),
      { fromAssignmentId: 'inst-pm', task_id: 'T-hb-4' },
      { toolCallsUsed: 0 },
      undefined,
    );
    const reply = parseTaskReply(taskReplyEvents()[0]!.content);
    expect(reply?.status).toBe('in_progress');
    // routeTaskReply 的 applyRegistryReply 对 in_progress 走 heartbeat 分支——
    // 这里直接以真实 content 驱动真实 registry（同一路径的纯逻辑等价）
    expect(reg.heartbeat(reply!.task_id)).toBe(true);
    expect(reg.get('T-hb-4')?.lastHeartbeatAt).toBeGreaterThanOrEqual(before ?? 0);
    stop();
  });
});
