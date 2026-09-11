// electron/tests/agent/shutdown-preserve.test.ts
//
// v2.6.0 关机保态（计划补强裁定 1）回归锁 + 接线锁：
//   1. 回归锁：未 markShuttingDown 时崩溃收尾照旧（in_progress → failed）——
//      防关机保态分支破坏 C2 崩溃收尾语义（回归锁是验收线）
//   2. markShuttingDown 后 child exit → 任务行保持 in_progress（保留待启动恢复）
//      + finalizeStreamOnCrash 仍执行（消息行标 failed——UI 诚实呈现中断）
//   3. markShuttingDown 幂等（二次调用不炸）
//   4. 接线锁：destroyAllTaskDrivenRuntimes（生产 before-quit 链）前置
//      markShuttingDown——其后 child exit 不再把 in_progress 任务误标 failed
// 构造照 agent-runner.test.ts（真实 runner + mock child + 真实 SQLite）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';

// 与 agent-runner.test.ts 同款：extraction 最小 mock，防真实提取链跨模块读写测试库
vi.mock('../../src/main/memory/extraction', () => ({
  scheduleExtraction: vi.fn(),
}));

import {
  AgentRunner,
  markShuttingDown,
  __resetShuttingDownForTest,
} from '../../src/main/agent/agent-runner';
import {
  destroyAllTaskDrivenRuntimes,
  __clearRuntimeRegistryForTest,
} from '../../src/main/agent/runtime-registry';
import { WarmPool } from '../../src/main/agent/warm-pool';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertTask,
  transitionTaskStatus,
  getTask,
} from '../../src/main/storage/tasks/repo';
import {
  insertMessage,
  getMessageByStreamSessionId,
} from '../../src/main/storage/messages/repo';

/**
 * 构造仿真存活语义的 mock child（与 agent-runner.test.ts 同模式）：运行中
 * exitCode === null / connected === true；含 off 反注册。send 收到 task-config
 * 后异步回 task-ack（mock 子进程握手）。handleChildExit 不依赖 message handler，
 * 故本文件下述用例不消费 handler。
 */
function mkMockChild(): ChildProcess & { kill: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> } {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    pid: 12345,
    on: vi.fn((event: string, h: (...args: unknown[]) => void) => {
      handlers[event] = h;
    }),
    off: vi.fn(),
    send: vi.fn(() => true),
    kill: vi.fn(),
    connected: true,
    exitCode: null,
  } as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> };
}

function mkRunner(pool: WarmPool): AgentRunner {
  return new AgentRunner({
    agentAssignmentId: 'inst1',
    agentUserId: 'agent-bot-x1',
    workspaceId: 'ws1',
    warmPool: pool,
  });
}

const tmpRoot = path.join(os.tmpdir(), `ap-shutdown-preserve-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function setupDb(): string {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`,
    )
    .run('ws1', 'Test', '/tmp', '@owner:home');
  return 'ws1';
}

/** 建一个已到 in_progress 的任务行（draft → assigned → in_progress 合法链） */
function seedInProgressTask(title: string): string {
  const t = insertTask({ workspaceId: 'ws1', title, creatorUserId: '@owner:home' });
  transitionTaskStatus(t.id, 'assigned');
  transitionTaskStatus(t.id, 'in_progress');
  return t.id;
}

describe('关机保态 markShuttingDown（v2.6.0 计划补强裁定 1）', () => {
  beforeEach(() => {
    setupDb();
    // 测试隔离：每个用例从干净标志位起跑——重启标志跨用例残留会污染回归锁
    __resetShuttingDownForTest();
    __clearRuntimeRegistryForTest();
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
    __resetShuttingDownForTest();
    __clearRuntimeRegistryForTest();
  });

  it('回归锁：未 markShuttingDown 时崩溃收尾照旧——in_progress → failed（C2 语义逐字节保持）', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool);
    const taskId = seedInProgressTask('T-sp-regress');

    insertMessage({
      sessionId: '!r:home',
      sender: 'agent-bot-x1',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-sp-regress',
      status: 'streaming',
    });

    await runner.executeTask({
      taskId,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-sp-regress',
    });
    expect(runner.activeTaskCount()).toBe(1);

    // 子进程异常退出（exit code 1，无 end / task-end）—— 现有 C2 语义必须逐字节保持
    runner.handleChildExit(child, 1);

    expect(runner.activeTaskCount()).toBe(0);
    const row = getTask(taskId)!;
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toContain('agent 运行时异常退出');
    expect(getMessageByStreamSessionId('ss-sp-regress')!.status).toBe('failed');
  });

  it('markShuttingDown 后 child exit → 任务保持 in_progress + finalizeStreamOnCrash 仍执行（消息行 failed）', async () => {
    markShuttingDown();
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool);
    const taskId = seedInProgressTask('T-sp-shutting-down');

    insertMessage({
      sessionId: '!r:home',
      sender: 'agent-bot-x1',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-sp-sd',
      status: 'streaming',
    });

    await runner.executeTask({
      taskId,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-sp-sd',
    });
    expect(runner.activeTaskCount()).toBe(1);

    runner.handleChildExit(child, 1);

    // 任务行：保留 in_progress（启动恢复 T5 检测/续跑）
    expect(getTask(taskId)!.status).toBe('in_progress');
    // 消息行：finalizeStreamOnCrash 仍执行——UI 诚实呈现中断，恢复时翻回 streaming
    expect(getMessageByStreamSessionId('ss-sp-sd')!.status).toBe('failed');
    // 活跃表仍被清理（runtime 回收语义不变——只是任务行不动）
    expect(runner.activeTaskCount()).toBe(0);
  });

  it('markShuttingDown 幂等：二次调用不炸', () => {
    expect(() => {
      markShuttingDown();
      markShuttingDown();
      markShuttingDown();
    }).not.toThrow();
  });

  it('接线锁：destroyAllTaskDrivenRuntimes 前置 markShuttingDown——其后 child exit 不误标 in_progress 任务', async () => {
    // 本用例刻意不把 runner 注册进 agentRunners：模拟「kill 已触发的 exit 事件
    // 到达时 runner 仍在持有活跃 task 的真实时序边界」（生产中 destroyAll 与
    // child exit 之间存在同 macrotask 窗口——本测试锁的是 flag 传播契约，不是
    // destroy 回收路径，后者在 runtime-registry.test.ts 独立覆盖）。
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool);
    const taskId = seedInProgressTask('T-sp-wire');

    insertMessage({
      sessionId: '!r:home',
      sender: 'agent-bot-x1',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-sp-wire',
      status: 'streaming',
    });

    await runner.executeTask({
      taskId,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-sp-wire',
    });

    // 生产 before-quit 链入口：destroyAllTaskDrivenRuntimes 必须前置 markShuttingDown
    // ——置位失败则本用例 task 必转 failed（红绿变异记录）。
    destroyAllTaskDrivenRuntimes();

    // kill 触发的 exit 事件经 spawnForAgent onExit 闭包路由到 handleChildExit
    // （mock child 手动送达同语义——真实子进程 SIGTERM 退出 code 通常为 null）
    runner.handleChildExit(child, null);

    expect(getTask(taskId)!.status).toBe('in_progress'); // 不再误标 failed
    expect(getMessageByStreamSessionId('ss-sp-wire')!.status).toBe('failed'); // 流收尾保留
    expect(runner.activeTaskCount()).toBe(0);
  });
});