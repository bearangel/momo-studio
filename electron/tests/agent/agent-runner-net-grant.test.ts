// electron/tests/agent/agent-runner-net-grant.test.ts
//
// v2.4.x 网络信任门 agent-runner 接线锁（spec 2026-09-13 §5 / §8）：
//   - grants 注册/清理挂活跃任务表生命周期——ephemeral end / task-driven task-end /
//     runner destroy 三条收尾路径都清 sessionGrants（任务终态即删，不跨任务记忆）
//   - net-trust-op 子进程请求在 messageHandler 拦截并路由到主进程信任门，
//     应答按 requestId 原样回带（跨模块 ID 单点透传——P0-7 教训）
// fixture 形态照抄 agent-runner-budget.test.ts（mock child + WarmPool + DB）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentRunner, markShuttingDown, __resetShuttingDownForTest } from '../../src/main/agent/agent-runner';
import { WarmPool } from '../../src/main/agent/warm-pool';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  initNetworkTrustGate,
  getNetworkTrustGate,
  __resetNetworkTrustGateForTest,
} from '../../src/main/sandbox/network-trust';
import type { ChildProcess } from 'node:child_process';

vi.mock('../../src/main/memory/extraction', () => ({
  scheduleExtraction: vi.fn(),
}));

function mkMockChild(): ChildProcess & { send: ReturnType<typeof vi.fn> } {
  return {
    pid: 12345,
    on: vi.fn(),
    off: vi.fn(),
    send: vi.fn(() => true),
    kill: vi.fn(),
    connected: true,
    exitCode: null,
  } as unknown as ChildProcess & { send: ReturnType<typeof vi.fn> };
}

const tmpRoot = path.join(os.tmpdir(), `ap-runner-net-grant-${Date.now()}`);

/** 从 child.on 调用记录里取 message handler（每 task 各注册一次） */
function messageHandlerOf(child: ChildProcess, callIndex = 0): (msg: unknown) => void {
  const calls = (child.on as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const handlers = calls
    .filter((c) => c[0] === 'message')
    .map((c) => c[1] as (msg: unknown) => void);
  const handler = handlers[callIndex];
  if (!handler) throw new Error('message handler 未注册');
  return handler;
}

/** 从 child.send 调用记录里取指定类型的最新一条载荷 */
function sentPayloadOf(child: ChildProcess, type: string): Record<string, unknown> {
  const calls = (child.send as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const payloads = calls.map((c) => c[0]).filter(
    (m): m is Record<string, unknown> =>
      typeof m === 'object' && m !== null && (m as { type?: string }).type === type,
  );
  const payload = payloads[payloads.length - 1];
  if (!payload) throw new Error(`${type} 未发送`);
  return payload;
}

function setupDb(): void {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
}

async function mkRunner(): Promise<{ runner: AgentRunner; child: ChildProcess }> {
  const child = mkMockChild();
  const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
  await warmPool.warm('inst1');
  return {
    runner: new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-x1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    }),
    child,
  };
}

describe('AgentRunner 网络信任门接线（v2.4.x）', () => {
  beforeEach(() => {
    setupDb();
    // 真 gate + 桩依赖：断言直接读 grants 生效状态（生产消费路径）
    initNetworkTrustGate({
      readPolicy: () => 'ask',
      persistAlways: () => {},
      pushNotice: () => {},
    });
  });
  afterEach(() => {
    __resetNetworkTrustGateForTest();
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('ephemeral end 收尾 → grants 清理（session 授权不跨任务记忆）', async () => {
    const gate = getNetworkTrustGate()!;
    const { runner, child } = await mkRunner();
    const ssn = 'ssn-eph-1';
    gate.__setGrantForTest(ssn, 'granted');
    expect(gate.effective(ssn).netOn).toBe(true);

    await runner.executeTask({
      taskId: null,
      executionSessionId: 'sess-1',
      body: 'hi',
      streamSessionId: ssn,
    });
    messageHandlerOf(child)({ type: 'end', streamSessionId: ssn, finishReason: 'stop' });
    await vi.waitFor(() => expect(gate.getGrant(ssn)).toBeUndefined());
    expect(gate.effective(ssn)).toEqual({ netOn: false, awaitingAsk: true });
  });

  it('task-driven task-end 收尾 → grants 清理（任务终态即删）', async () => {
    getDb()
      .prepare(
        `INSERT INTO tasks (id, workspace_id, title, status, creator_user_id, created_at, updated_at)
         VALUES ('task-1', 'ws1', 'T', 'in_progress', 'user-1', datetime('now'), datetime('now'))`,
      )
      .run();
    const gate = getNetworkTrustGate()!;
    const { runner, child } = await mkRunner();
    const ssn = 'ssn-task-1';
    gate.__setGrantForTest(ssn, 'granted');

    await runner.executeTask({
      taskId: 'task-1',
      executionSessionId: 'sess-1',
      body: 'hi',
      streamSessionId: ssn,
    });
    messageHandlerOf(child)({ type: 'end', streamSessionId: ssn, finishReason: 'stop' });
    messageHandlerOf(child)({ type: 'task-end', streamSessionId: ssn, toolCallsUsed: 3 });
    await vi.waitFor(() => expect(gate.getGrant(ssn)).toBeUndefined());
  });

  it('destroy 收尾 → 活跃任务的 grants 一并清理', async () => {
    const gate = getNetworkTrustGate()!;
    const { runner } = await mkRunner();
    const ssn = 'ssn-destroy-1';
    // 真实形态：grant 只会在任务活跃等待信任卡期间产生——先注册活跃任务再注入
    await runner.executeTask({
      taskId: null,
      executionSessionId: 'sess-1',
      body: 'hi',
      streamSessionId: ssn,
    });
    gate.__setGrantForTest(ssn, 'granted');
    runner.destroy();
    expect(gate.getGrant(ssn)).toBeUndefined();
  });

  it('child exit（崩溃/被杀，无 end/task-end）收尾 → grants 同样清理'
    + '（防 resume 复用 breakpointSsId 时继承 stale denied——「恢复后永远 net-off 不再问」链路）', async () => {
    const gate = getNetworkTrustGate()!;
    const { runner, child } = await mkRunner();
    const ssn = 'ssn-exit-1';
    await runner.executeTask({
      taskId: null,
      executionSessionId: 'sess-1',
      body: 'hi',
      streamSessionId: ssn,
    });
    gate.__setGrantForTest(ssn, 'denied');
    runner.handleChildExit(child, 1);
    expect(gate.getGrant(ssn)).toBeUndefined();
    // 清理后同 ID 恢复询问语义（resume 复用该 ID 时不再继承 stale denied）
    expect(gate.effective(ssn)).toEqual({ netOn: false, awaitingAsk: true });
  });

  it('关机保态路径（markShuttingDown + exit）→ grants 同样清理（保的是任务行 in_progress，不是会话级授权）', async () => {
    const gate = getNetworkTrustGate()!;
    const { runner, child } = await mkRunner();
    const ssn = 'ssn-shutdown-1';
    await runner.executeTask({
      taskId: null,
      executionSessionId: 'sess-1',
      body: 'hi',
      streamSessionId: ssn,
    });
    gate.__setGrantForTest(ssn, 'granted');
    markShuttingDown();
    try {
      runner.handleChildExit(child, null);
      expect(gate.getGrant(ssn)).toBeUndefined();
    } finally {
      __resetShuttingDownForTest();
    }
  });

  it('net-trust-op(effective) 请求路由到信任门 + requestId 原样回带', async () => {
    const { runner, child } = await mkRunner();
    await runner.executeTask({
      taskId: null,
      executionSessionId: 'sess-1',
      body: 'hi',
      streamSessionId: 'ssn-op-1',
    });
    messageHandlerOf(child)({
      type: 'net-trust-op',
      requestId: 'req-eff-1',
      op: 'effective',
      streamSessionId: 'ssn-op-1',
    });
    await vi.waitFor(() => {
      const sent = sentPayloadOf(child, 'net-trust-op:result');
      expect(sent.requestId).toBe('req-eff-1');
      expect(sent.ok).toBe(true);
      expect(sent.payload).toEqual({ netOn: false, awaitingAsk: true });
    });
  });

  it('net-trust-op 载荷非法 → ok:false 中文错误回送（不裸抛、不挂死子进程）', async () => {
    const { runner, child } = await mkRunner();
    await runner.executeTask({
      taskId: null,
      executionSessionId: 'sess-1',
      body: 'hi',
      streamSessionId: 'ssn-op-2',
    });
    messageHandlerOf(child)({ type: 'net-trust-op', requestId: 'req-bad', op: 'bogus' });
    await vi.waitFor(() => {
      const sent = sentPayloadOf(child, 'net-trust-op:result');
      expect(sent.requestId).toBe('req-bad');
      expect(sent.ok).toBe(false);
      expect(String(sent.error)).toContain('非法');
    });
  });
});
