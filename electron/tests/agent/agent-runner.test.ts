// electron/tests/agent/agent-runner.test.ts
//
// AgentRunner（task-driven 核心重构）测试。
// 覆盖核心场景：
//   1. executeTask 从 warm pool 取 runtime，注入 task config
//   2. ephemeral chat（taskId=null）end chunk → 立即 release（旧语义保持）
//   3. abortStream 中断指定 task
//   4. destroy 释放所有活跃 runtime + warm pool
//   5. notifyTaskReply 转发
// C1/C3 回归锁（task-driven，taskId 非空，真实 SQLite）：
//   6. end 后不 kill（等 task-end）——旧实现 end 即 SIGTERM，掐断后续
//      task_reply/task-end，PM 侧 dispatch 挂满 9 分钟（C3）
//   7. task-end 到达 → 任务行转终态（completed/failed/cancelled 映射）→ 再 kill
//   8. 幂等与防御：终态已定跳过 / dispatch 派生 task_id 无任务行跳过
//   9. 15s 安全兜底（可配 taskEndGraceMs）强制回收
// C2 回归锁：
//   10. child exit（无 end）→ 活跃表清理 + streaming 消息置 failed +
//       in_progress 任务转 failed（中文 errorMessage）
// ChildProcess 用 mock（与 warm-pool.test.ts 同模式，避免真实 fork）——
// 按真实语义构造：运行中 exitCode === null / connected === true。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentRunner } from '../../src/main/agent/agent-runner';
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
import type { ChildProcess } from 'node:child_process';

/**
 * 构造 mock 子进程——记录 message handler 以便测试模拟子进程发 chunk。
 * send() 收到 task-config 后异步回 task-ack（模拟真实子进程握手）。
 */
function mkMockChild(): ChildProcess & { kill: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> } {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    pid: 12345,
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
  } as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> };
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

function mkRunner(pool: WarmPool, taskEndGraceMs?: number): AgentRunner {
  return new AgentRunner({
    agentAssignmentId: 'inst1',
    agentUserId: 'agent-bot-x1',
    workspaceId: 'ws1',
    config: {} as never,
    warmPool: pool,
    ...(taskEndGraceMs !== undefined ? { taskEndGraceMs } : {}),
  });
}

// === 基础场景（无需 DB：taskId 均为 null） ===

describe('AgentRunner', () => {
  it('executeTask 从 warm pool 取 runtime，注入 task config', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');

    const runner = mkRunner(warmPool);

    const result = await runner.executeTask({
      taskId: null,
      executionSessionId: '!room:home',
      body: 'hi',
      streamSessionId: 'ss-1',
    });
    expect(result.streamSessionId).toBe('ss-1');
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task-config',
        streamSessionId: 'ss-1',
        body: 'hi',
      }),
    );
    expect(runner.activeTaskCount()).toBe(1);
  });

  it('ephemeral chat（taskId=null）end chunk → 立即 release + 活跃表清理（旧语义保持）', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');

    const runner = mkRunner(warmPool);

    await runner.executeTask({
      taskId: null,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-1',
    });
    getMessageHandler(child)({ type: 'end', streamSessionId: 'ss-1', finishReason: 'stop' });
    expect(runner.activeTaskCount()).toBe(0);
    expect(child.kill).toHaveBeenCalled(); // ephemeral 无后续 IPC 依赖，end 即回收
  });

  it('abortStream 中断指定 task', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');

    const runner = mkRunner(warmPool);

    await runner.executeTask({
      taskId: null,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-1',
    });
    runner.abortStream('ss-1');
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'abort', streamSessionId: 'ss-1' }),
    );
  });

  it('destroy 释放所有活跃 runtime + warm pool', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');

    const runner = mkRunner(warmPool);
    await runner.executeTask({
      taskId: null,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-1',
    });
    runner.destroy();
    // destroy → release → child.kill（与 warm-pool.test.ts 同断言模式）
    expect(child.kill).toHaveBeenCalled();
  });

  it('notifyTaskReply 转发给活跃 ephemeral task 的子进程（PM 等待 dispatch 场景）', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');

    const runner = mkRunner(warmPool);

    // PM 正在跑 ephemeral chat（taskId=null）时收到子 agent 的回执。
    // dispatch 的 task_id 由 PM 子进程内部生成，runner 无法按 taskId 匹配——
    // 必须转发给活跃子进程，由子进程的 pendingReplies 精确匹配。
    await runner.executeTask({
      taskId: null,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-1',
    });

    await runner.notifyTaskReply({
      taskId: 'task-dispatch-9',
      status: 'completed',
      body: 'ok',
      toolCallsUsed: 2,
    });

    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task-reply',
        reply: expect.objectContaining({ taskId: 'task-dispatch-9', status: 'completed', body: 'ok' }),
      }),
    );
  });
});

// === C1/C3/C2：task-driven 生命周期（真实 SQLite） ===

const tmpRoot = path.join(os.tmpdir(), `ap-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function setupDb(): string {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // seed workspace（tasks / messages 表 FK 要求）
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

describe('AgentRunner task-driven 生命周期（C1/C3）', () => {
  beforeEach(() => {
    setupDb();
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('C3 回归锁：end chunk 到达后不 kill（等 task-end / exit），活跃表保持', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool, 10_000); // 宽限拉长，确保观察窗口内兜底不触发
    const taskId = seedInProgressTask('T-c3');

    await runner.executeTask({
      taskId,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-c3',
    });

    // 模拟子进程发 end chunk——旧实现此刻 SIGTERM，掐断后续 task_reply / task-end
    getMessageHandler(child)({ type: 'end', streamSessionId: 'ss-c3', finishReason: 'stop' });

    expect(child.kill).not.toHaveBeenCalled(); // 关键断言：不提前 kill
    expect(runner.activeTaskCount()).toBe(1); // 活跃表等待 task-end
    expect(getTask(taskId)!.status).toBe('in_progress'); // 终态只由 task-end 转换
  });

  it('C1 回归锁：task-end 到达 → 任务行转 completed（含 toolCallsUsed/completedAt）→ 之后才 kill', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool);
    const taskId = seedInProgressTask('T-c1-ok');

    await runner.executeTask({
      taskId,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-c1-ok',
    });

    // 子进程时序：end → task_reply（经桥，不经本 handler）→ task-end
    getMessageHandler(child)({ type: 'end', streamSessionId: 'ss-c1-ok', finishReason: 'stop' });
    getMessageHandler(child)({
      type: 'task-end',
      streamSessionId: 'ss-c1-ok',
      taskId,
      toolCallsUsed: 3,
    });

    const row = getTask(taskId)!;
    expect(row.status).toBe('completed');
    expect(row.completedAt).not.toBeNull();
    expect(row.toolCallsUsed).toBe(3);
    // 先转换后回收：kill 在终态落库之后发生（同 tick 内顺序由实现保证，
    // 此处断言终态与 kill 均已发生）
    expect(child.kill).toHaveBeenCalled();
    expect(runner.activeTaskCount()).toBe(0);
    expect(child.off).toHaveBeenCalled(); // handler 已反注册
  });

  it('C1：task-end 携带 error（子进程错误路径）→ failed + errorMessage', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool);
    const taskId = seedInProgressTask('T-c1-fail');

    await runner.executeTask({
      taskId,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-c1-fail',
    });

    getMessageHandler(child)({ type: 'end', streamSessionId: 'ss-c1-fail', finishReason: 'error', error: 'LLM 服务不可用' });
    getMessageHandler(child)({
      type: 'task-end',
      streamSessionId: 'ss-c1-fail',
      taskId,
      error: 'LLM 服务不可用',
    });

    const row = getTask(taskId)!;
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toBe('LLM 服务不可用');
  });

  it('C1：abortStream 中断（end finishReason=interrupted 先于 task-end）→ cancelled', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool);
    const taskId = seedInProgressTask('T-c1-abort');

    await runner.executeTask({
      taskId,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-c1-abort',
    });

    // 用户点停止 → 子进程 end(interrupted) → task-end（无 error）
    getMessageHandler(child)({ type: 'end', streamSessionId: 'ss-c1-abort', finishReason: 'interrupted' });
    getMessageHandler(child)({ type: 'task-end', streamSessionId: 'ss-c1-abort', taskId });

    expect(getTask(taskId)!.status).toBe('cancelled');
  });

  it('C1 幂等：任务行已是终态（用户提前 task:cancel）→ task-end 跳过转换，不抛错', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool);
    const taskId = seedInProgressTask('T-c1-cancelled');

    await runner.executeTask({
      taskId,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-c1-cancelled',
    });

    // 运行中用户取消（in_progress → cancelled 合法）
    transitionTaskStatus(taskId, 'cancelled');
    getMessageHandler(child)({ type: 'end', streamSessionId: 'ss-c1-cancelled', finishReason: 'interrupted' });
    expect(() =>
      getMessageHandler(child)({ type: 'task-end', streamSessionId: 'ss-c1-cancelled', taskId }),
    ).not.toThrow();
    expect(getTask(taskId)!.status).toBe('cancelled'); // 保持用户取消的终态
    expect(child.kill).toHaveBeenCalled(); // runtime 仍被正确回收
  });

  it('C1：dispatch 派生 task_id（tasks 表无对应行）→ 跳过转换但正常回收', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool);

    // routeDispatch 注入的 taskId 是 dispatch task_id（randomUUID，无任务行）
    const dispatchTaskId = '01928374-1111-4222-8333-444455556666';
    await runner.executeTask({
      taskId: dispatchTaskId,
      executionSessionId: '!r:home',
      body: 'sub task',
      streamSessionId: 'ss-c1-dispatch',
    });

    expect(() =>
      getMessageHandler(child)({ type: 'task-end', streamSessionId: 'ss-c1-dispatch', taskId: dispatchTaskId }),
    ).not.toThrow();
    expect(runner.activeTaskCount()).toBe(0);
    expect(child.kill).toHaveBeenCalled();
  });

  it('C3：安全兜底——end 后宽限期内无 task-end/exit → 强制回收 + 终态转换', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool, 20); // 注入小宽限期
    const taskId = seedInProgressTask('T-c3-grace');

    await runner.executeTask({
      taskId,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-c3-grace',
    });

    getMessageHandler(child)({ type: 'end', streamSessionId: 'ss-c3-grace', finishReason: 'stop' });
    expect(child.kill).not.toHaveBeenCalled();

    // 宽限期耗尽（子进程 hang，task-end 永不到达）
    await new Promise((r) => setTimeout(r, 60));

    expect(child.kill).toHaveBeenCalled(); // 强制 kill
    expect(runner.activeTaskCount()).toBe(0);
    expect(getTask(taskId)!.status).toBe('completed'); // 按 lastFinish(stop) 转换
  });

  it('C3：task-end 先于宽限期到达 → 兜底计时器被清除，不重复收尾', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool, 20);
    const taskId = seedInProgressTask('T-c3-clear');

    await runner.executeTask({
      taskId,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-c3-clear',
    });

    getMessageHandler(child)({ type: 'end', streamSessionId: 'ss-c3-clear', finishReason: 'stop' });
    getMessageHandler(child)({ type: 'task-end', streamSessionId: 'ss-c3-clear', taskId });
    const killCount = (child.kill as ReturnType<typeof vi.fn>).mock.calls.length;

    // 越过宽限期后不应有第二次 kill / 状态翻转
    await new Promise((r) => setTimeout(r, 60));
    expect((child.kill as ReturnType<typeof vi.fn>).mock.calls.length).toBe(killCount);
    expect(getTask(taskId)!.status).toBe('completed');
  });
});

describe('AgentRunner child exit 清理链（C2）', () => {
  beforeEach(() => {
    setupDb();
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('C2 回归锁：子进程退出（未发 end）→ 活跃表清理 + streaming 消息置 failed + in_progress 任务转 failed', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool);
    const taskId = seedInProgressTask('T-c2-crash');

    // 消息行处于 streaming（正常应由 end chunk 收尾；子进程崩溃则永远滞留）
    insertMessage({
      sessionId: '!r:home',
      sender: 'agent-bot-x1',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-c2-crash',
      status: 'streaming',
    });

    await runner.executeTask({
      taskId,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-c2-crash',
    });
    expect(runner.activeTaskCount()).toBe(1);

    // 子进程异常退出（exit code 1，无 end / task-end）
    runner.handleChildExit(child, 1);

    expect(runner.activeTaskCount()).toBe(0);
    const msg = getMessageByStreamSessionId('ss-c2-crash')!;
    expect(msg.status).toBe('failed');
    const row = getTask(taskId)!;
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toContain('agent 运行时异常退出');
  });

  it('C2 幂等：正常 task-end 路径已收尾 → 事后 exit 事件 no-op（消息不被二次改写）', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool);
    const taskId = seedInProgressTask('T-c2-idem');

    insertMessage({
      sessionId: '!r:home',
      sender: 'agent-bot-x1',
      eventType: 'm.room.message',
      body: '',
      streamSessionId: 'ss-c2-idem',
      status: 'streaming',
    });

    await runner.executeTask({
      taskId,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-c2-idem',
    });

    // 正常链路收尾（end stop → task-end → completed）
    getMessageHandler(child)({ type: 'end', streamSessionId: 'ss-c2-idem', finishReason: 'stop' });
    getMessageHandler(child)({ type: 'task-end', streamSessionId: 'ss-c2-idem', taskId });
    expect(getTask(taskId)!.status).toBe('completed');

    // 迟到的 exit 事件不得把已收尾的任务/消息改成 failed
    expect(() => runner.handleChildExit(child, 1)).not.toThrow();
    expect(getTask(taskId)!.status).toBe('completed');
  });

  it('C2：非 in_progress 状态的任务（如 paused）不被崩溃收尾改写（状态机合法性）', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = mkRunner(warmPool);
    const taskId = seedInProgressTask('T-c2-paused');
    transitionTaskStatus(taskId, 'paused'); // in_progress → paused（被抢占）

    await runner.executeTask({
      taskId,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-c2-paused',
    });

    runner.handleChildExit(child, 1);
    expect(getTask(taskId)!.status).toBe('paused'); // paused → failed 非法，不动
  });
});
