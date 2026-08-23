// electron/tests/agent/runtime-spawner-audit.test.ts
//
// audit:toolCall 子进程桥（P2 Task 8，恢复 v1 被删的审计桥）：
//   - child 消息不含 workspace/agent 身份 → 从 spawn 闭包 runtimeConfig 补全
//     （workspaceId + agentUserId——v2 本地身份字段）
//   - 字段缺失/类型漂移经 String()/Number()/=== true 收敛
//   - 模块级 auditCounter：每 200 次写入触发一次 enforceAuditQuota
//   - 非 audit 消息不触发审计路径
//
// fork 被 mock，message handler 被捕获后直接调用；insert/quota 模块被 mock
// （本测试只验证桥的转发逻辑，不落真库）。

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock 工厂被提升到 import 之前，用 vi.hoisted 共享 handler 捕获槽
const captured = vi.hoisted(() => ({
  handler: null as ((msg: unknown) => void) | null,
}));

vi.mock('node:child_process', () => ({
  fork: vi.fn(() => ({
    pid: 4242,
    on: (event: string, cb: (msg: unknown) => void) => {
      if (event === 'message') captured.handler = cb;
    },
    off: vi.fn(),
    send: vi.fn(),
    kill: vi.fn(),
    connected: true,
    once: vi.fn(),
  })),
}));

vi.mock('../../src/main/audit/insert', () => ({ insertToolCall: vi.fn() }));
vi.mock('../../src/main/audit/quota', () => ({ enforceAuditQuota: vi.fn() }));

import { spawnForAgent, __resetAuditCounterForTest } from '../../src/main/agent/runtime-spawner';
import { insertToolCall } from '../../src/main/audit/insert';
import { enforceAuditQuota } from '../../src/main/audit/quota';
import type { AgentRuntimeOpts } from '../../src/main/agent/runtime-config';

const runtimeConfig: AgentRuntimeOpts = {
  instanceId: 'inst1',
  workspaceId: 'ws-audit',
  workspaceDir: '/tmp/ws-audit',
  agentAssignmentId: 'inst1',
  agentUserId: 'agent-pm-1',
  teamSessionId: 'sess-team',
  systemPrompt: '',
  modelName: 'glm-4.7',
  llmApiKey: 'k',
};

/** spawn 一个 runtime 并返回捕获到的 message handler */
async function spawnAndGetHandler(): Promise<(msg: unknown) => void> {
  captured.handler = null;
  await spawnForAgent({
    assignmentId: 'inst1',
    runtimeConfig,
    onChunk: vi.fn(),
    onExit: vi.fn(),
  });
  expect(captured.handler).toBeTruthy();
  return captured.handler as (msg: unknown) => void;
}

const AUDIT_MSG = {
  type: 'audit:toolCall',
  toolName: 'read_file',
  inputSummary: '路径 README.md',
  outputSummary: '内容',
  success: true,
  durationMs: 42,
};

describe('runtime-spawner audit:toolCall 桥', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAuditCounterForTest();
  });

  it('audit:toolCall → insertToolCall 以闭包 runtimeConfig 补全身份', async () => {
    const handler = await spawnAndGetHandler();
    handler({ ...AUDIT_MSG });
    expect(insertToolCall).toHaveBeenCalledTimes(1);
    expect(insertToolCall).toHaveBeenCalledWith({
      workspaceId: 'ws-audit',
      agentBotUserId: 'agent-pm-1',
      toolName: 'read_file',
      inputSummary: '路径 README.md',
      outputSummary: '内容',
      success: true,
      durationMs: 42,
    });
  });

  it('字段缺失/类型漂移收敛为安全默认值', async () => {
    const handler = await spawnAndGetHandler();
    handler({ type: 'audit:toolCall' });
    expect(insertToolCall).toHaveBeenCalledWith({
      workspaceId: 'ws-audit',
      agentBotUserId: 'agent-pm-1',
      toolName: '',
      inputSummary: '',
      outputSummary: '',
      success: false,
      durationMs: 0,
    });
  });

  it('非 audit 消息不触发 insertToolCall / enforceAuditQuota', async () => {
    const onChunk = vi.fn();
    captured.handler = null;
    await spawnForAgent({ assignmentId: 'inst1', runtimeConfig, onChunk, onExit: vi.fn() });
    const handler = captured.handler!;
    handler({ type: 'text', text: 'hi' });
    handler('not-an-object');
    expect(insertToolCall).not.toHaveBeenCalled();
    expect(enforceAuditQuota).not.toHaveBeenCalled();
  });

  it('计数器：第 200 次写入触发一次 enforceAuditQuota（199 次不触发）', async () => {
    const handler = await spawnAndGetHandler();
    for (let i = 0; i < 199; i++) handler({ ...AUDIT_MSG });
    expect(enforceAuditQuota).not.toHaveBeenCalled();
    handler({ ...AUDIT_MSG });
    expect(enforceAuditQuota).toHaveBeenCalledTimes(1);
    expect(enforceAuditQuota).toHaveBeenCalledWith('ws-audit');
  });

  it('计数器跨 200 周期持续触发（400 次 → 2 次）', async () => {
    const handler = await spawnAndGetHandler();
    for (let i = 0; i < 400; i++) handler({ ...AUDIT_MSG });
    expect(enforceAuditQuota).toHaveBeenCalledTimes(2);
  });
});
