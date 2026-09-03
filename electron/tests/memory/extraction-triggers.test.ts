// electron/tests/memory/extraction-triggers.test.ts
//
// 提取触发接线测试（v2.2 记忆 P2 Task 4，spec §6.4 触发点）：
//   - AgentRunner.finalizeActiveTask：任务正常收尾（stop）→ release 之后触发
//     scheduleExtraction(executionSessionId, {taskId})；fire-and-forget（不阻塞收尾）
//   - 错误路径不触发：task-end 携带 error（failed）/ end finishReason=interrupted（abort）
//   - ephemeral chat（taskId=null，end 即回收，不经 finalizeActiveTask）→ 不触发
//   - session:send IPC：用户消息落库成功后 owner 消息数 % TRIGGER_TURN_INTERVAL === 0
//     且 count > 0 → 触发 scheduleExtraction(sessionId)
//   - session:send 失败（会话不存在）→ 错误原样传播且不触发
//
// 保真度约定（momo-test-rules）：
//   - 只 mock 边界：extraction.scheduleExtraction（被测接线的对端 spy）、
//     electron.ipcMain（注册表捕获）、p2p.broadcastLocalMessage（网络栈）
//   - 其余全真实：AgentRunner / WarmPool / 真实 SQLite（任务行终态转换、
//     owner 消息计数、sendUserMessage 落库全链）；TRIGGER_TURN_INTERVAL 用真实常量
//   - mock child 按真实语义构造（connected=true / exitCode=null；on 记录 handler
//     供测试模拟子进程发 chunk，与 agent-runner.test.ts 同模式）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';

// ─── 边界 mock（vi.mock 工厂提升到 import 之前，可变桩经 vi.hoisted 声明）──────

const { scheduleExtractionSpy, ipcHandlers, mockBroadcast } = vi.hoisted(() => ({
  scheduleExtractionSpy: vi.fn(),
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  mockBroadcast: vi.fn(),
}));

// extraction 模块：仅覆写 scheduleExtraction（被测接线对端的 spy）；
// TRIGGER_TURN_INTERVAL 等常量与 runExtraction 保持真实（importOriginal）
vi.mock('../../src/main/memory/extraction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/memory/extraction')>();
  return { ...actual, scheduleExtraction: scheduleExtractionSpy };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

// p2p 网络栈打桩（session-service 真实链路依赖；与 session-service.test.ts 同法）
vi.mock('../../src/main/p2p', () => ({
  broadcastLocalMessage: mockBroadcast,
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { AgentRunner } from '../../src/main/agent/agent-runner';
import { WarmPool } from '../../src/main/agent/warm-pool';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertTask,
  transitionTaskStatus,
  getTask,
} from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { insertMessage } from '../../src/main/storage/messages/repo';
import { registerSessionIpcHandlers } from '../../src/main/im/session.ipc.handlers';
import { TRIGGER_TURN_INTERVAL } from '../../src/main/memory/extraction';

// ─── 测试基建 ────────────────────────────────────────────────────────────────

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-extraction-triggers-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

function setupDb(): void {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // seed workspace（tasks / sessions 表 FK 要求）
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
}

/** mock 子进程——on() 记录 message handler 供测试模拟子进程发 chunk（真实语义：运行中） */
function mkMockChild(): ChildProcess {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    pid: 23456,
    on: vi.fn((event: string, h: (...args: unknown[]) => void) => {
      handlers[event] = h;
    }),
    off: vi.fn(),
    send: vi.fn(() => true),
    kill: vi.fn(),
    connected: true,
    exitCode: null,
  } as unknown as ChildProcess;
}

/** 从 mock child 的 on() 调用记录里取回注册的 message handler */
function getMessageHandler(child: ChildProcess): (msg: unknown) => void {
  const onCalls = (child.on as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const handler = onCalls.find((c) => c[0] === 'message')?.[1] as
    | ((msg: unknown) => void)
    | undefined;
  if (!handler) throw new Error('message handler 未注册');
  return handler;
}

function mkRunner(pool: WarmPool): AgentRunner {
  return new AgentRunner({
    agentAssignmentId: 'inst1',
    agentUserId: 'agent-bot-x1',
    workspaceId: 'ws1',
    config: {} as never,
    warmPool: pool,
  });
}

/** 建一个已到 in_progress 的任务行（draft → assigned → in_progress 合法链） */
function seedInProgressTask(title: string): string {
  const t = insertTask({ workspaceId: 'ws1', title, creatorUserId: '@owner:home' });
  transitionTaskStatus(t.id, 'assigned');
  transitionTaskStatus(t.id, 'in_progress');
  return t.id;
}

/** 预置 n 条 owner 消息（轮次计数基数；时间戳由 insertMessage 侧唯一化） */
function seedOwnerMessages(sessionId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    insertMessage({
      sessionId,
      sender: 'owner',
      eventType: 'm.room.message',
      body: `预置消息 ${i}`,
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  ipcHandlers.clear();
  setupDb();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// ─── 触发点 1：AgentRunner.finalizeActiveTask（任务收尾）─────────────────────

describe('AgentRunner 完成触发', () => {
  it('任务正常收尾（end stop → task-end）→ 触发 scheduleExtraction(executionSessionId, {taskId})', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool);
    const taskId = seedInProgressTask('T-trig-ok');

    await runner.executeTask({
      taskId,
      executionSessionId: 'sess-trig-1',
      body: 'x',
      streamSessionId: 'ss-trig-ok',
    });

    // 子进程时序：end → task-end（无 error）
    getMessageHandler(child)({ type: 'end', streamSessionId: 'ss-trig-ok', finishReason: 'stop' });
    getMessageHandler(child)({ type: 'task-end', streamSessionId: 'ss-trig-ok', taskId });

    // 收尾先行（任务终态可见 + runtime 回收），提取 fire-and-forget 不影响二者
    expect(getTask(taskId)!.status).toBe('completed');
    expect(child.kill).toHaveBeenCalled();
    expect(scheduleExtractionSpy).toHaveBeenCalledTimes(1);
    expect(scheduleExtractionSpy).toHaveBeenCalledWith('sess-trig-1', { taskId });
  });

  it('task-end 携带 error（错误路径 → failed）→ 不触发', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool);
    const taskId = seedInProgressTask('T-trig-fail');

    await runner.executeTask({
      taskId,
      executionSessionId: 'sess-trig-2',
      body: 'x',
      streamSessionId: 'ss-trig-fail',
    });

    getMessageHandler(child)({
      type: 'end',
      streamSessionId: 'ss-trig-fail',
      finishReason: 'error',
      error: 'LLM 服务不可用',
    });
    getMessageHandler(child)({
      type: 'task-end',
      streamSessionId: 'ss-trig-fail',
      taskId,
      error: 'LLM 服务不可用',
    });

    expect(getTask(taskId)!.status).toBe('failed');
    expect(scheduleExtractionSpy).not.toHaveBeenCalled();
  });

  it('end finishReason=interrupted（用户中止 → cancelled）→ 不触发', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool);
    const taskId = seedInProgressTask('T-trig-abort');

    await runner.executeTask({
      taskId,
      executionSessionId: 'sess-trig-3',
      body: 'x',
      streamSessionId: 'ss-trig-abort',
    });

    getMessageHandler(child)({ type: 'end', streamSessionId: 'ss-trig-abort', finishReason: 'interrupted' });
    getMessageHandler(child)({ type: 'task-end', streamSessionId: 'ss-trig-abort', taskId });

    expect(getTask(taskId)!.status).toBe('cancelled');
    expect(scheduleExtractionSpy).not.toHaveBeenCalled();
  });

  it('ephemeral chat（taskId=null，end 即回收不经 finalizeActiveTask）→ 不触发', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool);

    await runner.executeTask({
      taskId: null,
      executionSessionId: 'sess-trig-4',
      body: 'x',
      streamSessionId: 'ss-trig-eph',
    });

    getMessageHandler(child)({ type: 'end', streamSessionId: 'ss-trig-eph', finishReason: 'stop' });

    expect(child.kill).toHaveBeenCalled();
    expect(scheduleExtractionSpy).not.toHaveBeenCalled();
  });
});

// ─── 触发点 2：session:send IPC（用户消息轮次）───────────────────────────────

describe('session:send 轮次触发', () => {
  it(`owner 消息数（含本条）到 ${TRIGGER_TURN_INTERVAL} 的整数倍 → 触发 scheduleExtraction(sessionId)`, async () => {
    registerSessionIpcHandlers();
    const session = insertSession({ workspaceId: 'ws1', title: 'T', titleAuto: true });
    seedOwnerMessages(session.id, TRIGGER_TURN_INTERVAL - 1);

    await ipcHandlers.get('session:send')!({} as never, session.id, '第 20 条', undefined);

    expect(scheduleExtractionSpy).toHaveBeenCalledTimes(1);
    expect(scheduleExtractionSpy).toHaveBeenCalledWith(session.id);
  });

  it(`非整数倍轮次（${TRIGGER_TURN_INTERVAL - 1} 条）→ 不触发`, async () => {
    registerSessionIpcHandlers();
    const session = insertSession({ workspaceId: 'ws1', title: 'T', titleAuto: true });
    seedOwnerMessages(session.id, TRIGGER_TURN_INTERVAL - 2);

    await ipcHandlers.get('session:send')!({} as never, session.id, '第 19 条', undefined);

    expect(scheduleExtractionSpy).not.toHaveBeenCalled();
  });

  it('sendUserMessage 失败（会话不存在）→ 错误原样传播且不触发', async () => {
    registerSessionIpcHandlers();

    await expect(
      ipcHandlers.get('session:send')!({} as never, 'sess-404', 'x', undefined),
    ).rejects.toThrow('会话不存在');
    expect(scheduleExtractionSpy).not.toHaveBeenCalled();
  });
});
