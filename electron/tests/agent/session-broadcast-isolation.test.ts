// electron/tests/agent/session-broadcast-isolation.test.ts
//
// 同会话旁系中止隔离（R1 相邻发现收口，2026-11-05）：车道未命中的 fallback
// 广播（abortTasksBySessionEverywhere）历史上按执行会话全杀——同会话在途
// dispatch 链的子流 / PM 源流属另一任务链，被误杀后 233 秒遭 sweepDead 误判
// 「心跳超时」（错误死因 + 僵尸窗口）。本回归锁四个语义面：
//   1. 取消普通任务 → 他链（taskId ≠ 被取消任务）在途流豁免，链保持 in_flight
//   2. 无链认领的流（自有流竞态窗口 / 手输流旧语义）照收 abort——安全网保持
//   3. 取消 dispatch 任务本尊 → 其名下链的子流不豁免（照杀；链终态由
//      settleChainForTaskUserAction 落，见 dispatch-task-user-action-receipt.test）
//   4. 不传 ownedTaskId 的旧调用方 → 全杀行为逐字节不变
//
// 形态沿 agent-runner-quota.test.ts：真 DB + 真 AgentRunner/WarmPool +
// ChildProcess mock（task-config 自动回 task-ack），断言经 child.send spy。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';

vi.mock('../../src/main/memory/extraction', () => ({
  scheduleExtraction: vi.fn(),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { AgentRunner } from '../../src/main/agent/agent-runner';
import { WarmPool } from '../../src/main/agent/warm-pool';
import {
  __pushRunnerForTest,
  __clearRuntimeRegistryForTest,
} from '../../src/main/agent/runtime-registry';
import {
  dispatchRegistry,
  __resetDispatchRegistryForTest,
} from '../../src/main/agent/dispatch-registry';
import { __clearLaneForTest } from '../../src/main/agent/session-lane';
import { cancelTask } from '../../src/main/task/lifecycle';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-lane-isolation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const USER_TASK_ID = 't-user-1';
const DISPATCH_TASK_ID = 't-dispatch-2';
const SUB_STREAM = 'ss-sub-2';
const PM_STREAM = 'ss-pm-2';
let sessionId = '';

function setupDb(): void {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`,
  ).run();
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
        default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
      VALUES ('inst-sub', 'sub', 'sub', '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
      VALUES ('inst-sub', 'ws', 'inst-sub', 'agent-sub')`,
  ).run();
  sessionId = insertSession({ workspaceId: 'ws', title: '协作', kind: 'chat' }).id;
}

/** 普通任务板任务（两回合空档被取消——车道无记录的典型实战形态） */
function seedUserTask(): void {
  insertTask({
    id: USER_TASK_ID,
    workspaceId: 'ws',
    title: '普通任务',
    status: 'in_progress',
    creatorUserId: 'u-1',
    executionSessionId: sessionId,
    startedAt: Date.now(),
  });
}

/** dispatch 簿记行（ledgerInsertDispatch 落库形态） */
function seedDispatchTask(): void {
  insertTask({
    id: DISPATCH_TASK_ID,
    origin: 'dispatch',
    workspaceId: 'ws',
    title: '子任务',
    status: 'in_progress',
    creatorUserId: 'agent:inst-pm',
    assigneeAgentId: 'inst-sub',
    executionSessionId: sessionId,
    sourceSessionId: sessionId,
    startedAt: Date.now(),
  });
}

/** 在途链注册（生产 routeDispatch 形态——子流 + PM 源流都在本会话） */
function registerInFlightChain(): void {
  dispatchRegistry.register({
    taskId: DISPATCH_TASK_ID,
    pmAssignmentId: 'inst-pm',
    subAssignmentId: 'inst-sub',
    sessionId,
    subStreamSessionId: SUB_STREAM,
    pmStreamSessionId: PM_STREAM,
    isFollowupRound: false,
  });
}

function mkMockChild(): ChildProcess {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    pid: 23456,
    on: vi.fn((event: string, h: (...args: unknown[]) => void) => {
      handlers[event] = h;
    }),
    off: vi.fn(),
    send: vi.fn((msg: unknown) => {
      if (
        typeof msg === 'object' &&
        msg !== null &&
        (msg as { type?: string }).type === 'task-config'
      ) {
        setTimeout(
          () =>
            handlers['message']?.({
              type: 'task-ack',
              streamSessionId: (msg as { streamSessionId: string }).streamSessionId,
            }),
          0,
        );
      }
      return true;
    }),
    kill: vi.fn(),
    connected: true,
    exitCode: null,
  } as unknown as ChildProcess;
}

/** 建真实 runner + 活跃流（executeTask 真路径），并注册进全局 runner 表 */
async function spawnActiveStream(streamSessionId: string, taskId: string | null): Promise<ChildProcess> {
  const child = mkMockChild();
  const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
  await warmPool.warm('inst-sub');
  const runner = new AgentRunner({
    agentAssignmentId: 'inst-sub',
    agentUserId: 'agent-sub',
    workspaceId: 'ws',
    warmPool,
    taskEndGraceMs: 10_000,
  });
  __pushRunnerForTest(runner);
  await runner.executeTask({
    taskId,
    executionSessionId: sessionId,
    body: 'x',
    streamSessionId,
  });
  return child;
}

/** 收集 child.send 收到的 abort 消息目标流 id */
function abortTargets(child: ChildProcess): string[] {
  const calls = (child.send as unknown as ReturnType<typeof vi.fn>).mock.calls;
  return calls
    .map((c) => c[0] as { type?: string; streamSessionId?: string })
    .filter((m) => m !== null && typeof m === 'object' && m.type === 'abort' && typeof m.streamSessionId === 'string')
    .map((m) => m.streamSessionId as string);
}

describe('fallback 会话广播旁系隔离（R1 相邻发现收口）', () => {
  beforeEach(() => {
    __clearRuntimeRegistryForTest();
    __resetDispatchRegistryForTest();
    __clearLaneForTest();
    setupDb();
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
    __clearRuntimeRegistryForTest();
    __resetDispatchRegistryForTest();
    __clearLaneForTest();
  });

  it('取消普通任务（车道空档）→ 他链子流豁免：不收 abort，链保持 in_flight', async () => {
    seedUserTask();
    seedDispatchTask();
    registerInFlightChain();
    const child = await spawnActiveStream(SUB_STREAM, DISPATCH_TASK_ID);

    await cancelTask(USER_TASK_ID);

    expect(abortTargets(child), '他链子流不得被 fallback 广播误杀').toEqual([]);
    expect(dispatchRegistry.get(DISPATCH_TASK_ID)?.status, '链不受扰——自然跑完').toBe('in_flight');
  });

  it('无链认领的活跃流照收 abort——fallback 安全网保持（自有流竞态窗口 / 手输旧语义）', async () => {
    seedUserTask();
    const child = await spawnActiveStream('ss-unclaimed', null);

    await cancelTask(USER_TASK_ID);

    expect(abortTargets(child)).toEqual(['ss-unclaimed']);
  });

  it('取消 dispatch 任务本尊 → 其名下链子流不豁免（照杀——链终态由 settle 落）', async () => {
    seedDispatchTask();
    registerInFlightChain();
    const child = await spawnActiveStream(SUB_STREAM, DISPATCH_TASK_ID);

    await cancelTask(DISPATCH_TASK_ID);

    expect(abortTargets(child), '本尊链的子流不在豁免集').toEqual([SUB_STREAM]);
  });

  it('不传 ownedTaskId（旧调用方）→ 全杀行为不变（含链认领流）', async () => {
    seedDispatchTask();
    registerInFlightChain();
    const child = await spawnActiveStream(SUB_STREAM, DISPATCH_TASK_ID);
    const { abortTasksBySessionEverywhere } = await import('../../src/main/agent/runtime-registry');

    const hit = abortTasksBySessionEverywhere(sessionId);

    expect(hit).toBe(true);
    expect(abortTargets(child)).toEqual([SUB_STREAM]);
  });
});
