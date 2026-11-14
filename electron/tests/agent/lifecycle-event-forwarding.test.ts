// electron/tests/agent/lifecycle-event-forwarding.test.ts
//
// P1 回归锁（E2E 2026-11-14 live 复现）：agent 工具（request_human / submit_task /
// fail_task）在 runtime 子进程执行——子进程侧 lifecycle-runs 的 sink 从未注册
// （sink 只在主进程 registerHumanIpc 装配），emitRunChanged / emitHumanChanged
// 静默 no-op，主进程 / renderer 永远收不到 agent 侧发起的推送（run submitted /
// 人工请求 inserted / run waiting_human），只有面板重挂载或轮询才更新。
//
// 修复形态（sink 转发经既有 child→main 消息泵）：
//   - 子进程侧：forwardLifecycleEvents(send) 把两 sink 接到 process.send
//     （消息 {type:'lifecycle-event', channel, payload}）
//   - 主进程侧：agent-runner messageHandler 新增 lifecycle-event 分支（流过滤前）
//     → emitRunChanged / emitHumanChanged 复用主进程自己装配的 sink 推 renderer
//
// 本文件锁两端（producer/consumer 成对，boundary-rules 第 4 条）：
//   1) 子进程侧（真实 DB，无 mock）：forwardLifecycleEvents 注册后，submitRun /
//      requestHuman 在进程内触发 → send 回调按通道收到载荷（生产 = process.send）
//   2) 主进程侧（mock child，agent-runner-browser-op.test.ts 同款夹具）：
//      lifecycle-event 消息（不带 streamSessionId）→ 主进程 sink 按通道被调；
//      畸形载荷防御性丢弃不抛错（child 是自有进程，信任级同 task-op，宽校验）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { listByTask } from '../../src/main/storage/tasks/human-requests-repo';
import {
  forwardLifecycleEvents,
  requestHuman,
  setHumanChangedSink,
  setRemoteInterveneSink,
  setTaskRunChangedSink,
  startRun,
  submitRun,
  type HumanChangedEvent,
  type RemoteInterveneEvent,
  type TaskRunChangedEvent,
} from '../../src/main/task/lifecycle-runs';
import { AgentRunner } from '../../src/main/agent/agent-runner';
import { WarmPool } from '../../src/main/agent/warm-pool';

// ─── 共用：sink 是模块级单例，每个用例后必须还原（防跨用例污染） ─────────────
function restoreSinks(): void {
  setHumanChangedSink(null);
  setTaskRunChangedSink(null);
  setRemoteInterveneSink(null);
}

// ═══ 1) 子进程侧：forwardLifecycleEvents 接线（真实 DB） ═════════════════════

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-lifecycle-fwd-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/** 验收/人工请求挂任务的执行会话（human_requests.session_id FK → sessions） */
let execSessionId = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  execSessionId = insertSession({ workspaceId: 'ws1', title: '执行', kind: 'chat' }).id;
});

afterEach(() => {
  restoreSinks();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 种一个 assigned 任务（生产合法起点，lifecycle-runs-submit.test.ts 同款） */
function seedAssignedTask(): string {
  const t = insertTask({
    workspaceId: 'ws1',
    title: 'T',
    creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1',
    status: 'assigned',
    executionSessionId: execSessionId,
  });
  return t.id;
}

describe('1) forwardLifecycleEvents：子进程侧 sink 转发（真实 DB）', () => {
  it('submitRun → send 回调收到 task:runChanged(submitted) + human:changed(inserted)', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    forwardLifecycleEvents((channel, payload) => sent.push({ channel, payload }));

    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    await submitRun(taskId, { summary: '交付完成' });

    // run 通道：startRun(running) + submitRun(submitted) 两跳都有（载荷=生产 sink 原样形状）
    const runEvents = sent
      .filter((e) => e.channel === 'task:runChanged')
      .map((e) => e.payload as TaskRunChangedEvent);
    expect(runEvents).toContainEqual({ taskId, runId: run.id, status: 'running' });
    expect(runEvents).toContainEqual({ taskId, runId: run.id, status: 'submitted' });

    // human 通道：acceptance 请求 inserted，requestId 是真实落库行 id（非占位符）
    const acceptance = listByTask(taskId).find((r) => r.kind === 'acceptance')!;
    expect(acceptance).toBeDefined();
    const humanEvents = sent
      .filter((e) => e.channel === 'human:changed')
      .map((e) => e.payload as HumanChangedEvent);
    expect(humanEvents).toEqual([
      { sessionId: execSessionId, requestId: acceptance.id, kind: 'inserted' },
    ]);
  });

  it('requestHuman（绑 run）→ send 回调收到 task:runChanged(waiting_human) + human:changed(inserted)', () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    forwardLifecycleEvents((channel, payload) => sent.push({ channel, payload }));

    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    const row = requestHuman({
      sessionId: execSessionId,
      kind: 'question',
      title: '需要确认',
      prompt: '选 A 还是 B',
      taskId,
    });

    const runEvents = sent
      .filter((e) => e.channel === 'task:runChanged')
      .map((e) => e.payload as TaskRunChangedEvent);
    expect(runEvents).toContainEqual({ taskId, runId: run.id, status: 'waiting_human' });

    const humanEvents = sent
      .filter((e) => e.channel === 'human:changed')
      .map((e) => e.payload as HumanChangedEvent);
    expect(humanEvents).toEqual([
      { sessionId: execSessionId, requestId: row.id, kind: 'inserted' },
    ]);
  });

  it('未接线（bug 原状）→ emit 静默 no-op 不抛错（sink null 语义保持，子进程零负担）', async () => {
    // 不调 forwardLifecycleEvents——sink 保持 null，submitRun 照常落库不崩
    // （这是 bug 的静默面：不是崩溃而是丢推送；锁 no-op 语义防止修复引入抛错）
    const taskId = seedAssignedTask();
    startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    await expect(submitRun(taskId, { summary: '交付' })).resolves.toBeUndefined();
    expect(listByTask(taskId).some((r) => r.kind === 'acceptance')).toBe(true);
  });

  // ─── S2（2026-11-14）：remote-intervene 第三通道（worker 干预/提交桥转发） ───

  it('requestHuman / submitRun → send 回调收到 remote-intervene（request_created + run_submitted）', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    forwardLifecycleEvents((channel, payload) => sent.push({ channel, payload }));

    // 两事件各用独立任务（request_human 落行后 run 挂等人体，同任务无法直接提交）
    const askTaskId = seedAssignedTask();
    const askRun = startRun(askTaskId, { trigger: 'initial', executionSessionId: execSessionId });
    const row = requestHuman({
      sessionId: execSessionId,
      kind: 'question',
      title: '需要确认',
      prompt: '选 A',
      taskId: askTaskId,
      runId: askRun.id,
    });
    const submitTaskId = seedAssignedTask();
    const submitRun1 = startRun(submitTaskId, { trigger: 'initial', executionSessionId: execSessionId });
    await submitRun(submitTaskId, { summary: '交付完成', files: ['a.ts'] });

    const remoteEvents = sent
      .filter((e) => e.channel === 'remote-intervene')
      .map((e) => e.payload as RemoteInterveneEvent);
    // request_created：载荷=落库行原样（interventionId 桥消费的单源）
    expect(remoteEvents).toContainEqual({
      kind: 'request_created',
      request: expect.objectContaining({ id: row.id, kind: 'question', taskId: askTaskId }),
    });
    // run_submitted：runNo + deliverable 原样透传（reason 序列化在主进程桥侧）
    expect(remoteEvents).toContainEqual({
      kind: 'run_submitted',
      taskId: submitTaskId,
      runNo: submitRun1.runNo,
      deliverable: { summary: '交付完成', files: ['a.ts'], artifacts: [] },
    });
  });
});

// ═══ 2) 主进程侧：agent-runner messageHandler 的 lifecycle-event 分支 ════════

/** 构造 mock 子进程：记录 message handler 供测试模拟子进程发消息
 *  （agent-runner-browser-op.test.ts 同模式，避免真实 fork；只留本用例
 *  所需的最小面——message 注册 + emit 触达） */
function mkFakeChild(): { child: ChildProcess; emit: (msg: unknown) => void } {
  let handler: ((msg: unknown) => void) | null = null;
  const child = {
    pid: 12345,
    on: (_e: string, h: (msg: unknown) => void) => {
      if (_e === 'message') handler = h;
    },
    off: () => undefined,
    send: () => true,
    kill: () => true,
    connected: true,
    exitCode: null,
  } as unknown as ChildProcess;
  return {
    child,
    emit: (msg: unknown) => {
      if (!handler) throw new Error('message handler 未注册');
      handler(msg);
    },
  };
}

describe('2) agent-runner lifecycle-event 分支（主进程侧分发）', () => {
  afterEach(() => restoreSinks());

  it("task:runChanged 载荷 → 主进程 runChanged sink 收到原样事件（不经流过滤）", async () => {
    const { child, emit } = mkFakeChild();
    const warmPool = new WarmPool({ spawn: () => Promise.resolve(child) });
    await warmPool.warm('inst1');
    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-x1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });
    await runner.executeTask({
      taskId: null,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-1', // 活跃流是 ss-1；lifecycle-event 不带该字段
    });

    const runEvents: TaskRunChangedEvent[] = [];
    setTaskRunChangedSink((e) => runEvents.push(e));

    // 消息不带 streamSessionId——必须先于「只处理本 task 的 chunk」过滤分发
    emit({
      type: 'lifecycle-event',
      channel: 'task:runChanged',
      payload: { taskId: 'T-9', runId: 'run-9', status: 'submitted' },
    });

    expect(runEvents).toEqual([{ taskId: 'T-9', runId: 'run-9', status: 'submitted' }]);
    // 分支 return 不污染活跃 task（不触发收尾）
    expect(runner.activeTaskCount()).toBe(1);

    await runner.destroy();
  });

  it('human:changed 载荷 → 主进程 humanChanged sink 收到原样事件', async () => {
    const { child, emit } = mkFakeChild();
    const warmPool = new WarmPool({ spawn: () => Promise.resolve(child) });
    await warmPool.warm('inst1');
    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-x1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });
    await runner.executeTask({
      taskId: null,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-1',
    });

    const humanEvents: HumanChangedEvent[] = [];
    setHumanChangedSink((e) => humanEvents.push(e));

    emit({
      type: 'lifecycle-event',
      channel: 'human:changed',
      payload: { sessionId: 's-1', requestId: 'hr-1', kind: 'inserted' },
    });

    expect(humanEvents).toEqual([{ sessionId: 's-1', requestId: 'hr-1', kind: 'inserted' }]);
    expect(runner.activeTaskCount()).toBe(1);
    await runner.destroy();
  });

  it('remote-intervene 载荷 → 主进程 remoteInterveneSink 收到原样事件（S2 第三通道）', async () => {
    const { child, emit } = mkFakeChild();
    const warmPool = new WarmPool({ spawn: () => Promise.resolve(child) });
    await warmPool.warm('inst1');
    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-x1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });
    await runner.executeTask({
      taskId: null,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-1',
    });

    const remoteEvents: RemoteInterveneEvent[] = [];
    setRemoteInterveneSink((e) => remoteEvents.push(e));

    emit({
      type: 'lifecycle-event',
      channel: 'remote-intervene',
      payload: { kind: 'run_submitted', taskId: 'T-9', runNo: 2, deliverable: { summary: '交付' } },
    });
    emit({
      type: 'lifecycle-event',
      channel: 'remote-intervene',
      payload: { kind: 'request_created', request: { id: 'hr-1', sessionId: 's-1', kind: 'question' } },
    });
    // 畸形载荷防御性丢弃不抛错（request 缺 id / runNo 非数字）
    expect(() => {
      emit({ type: 'lifecycle-event', channel: 'remote-intervene', payload: { kind: 'request_created', request: { kind: 'question' } } });
      emit({ type: 'lifecycle-event', channel: 'remote-intervene', payload: { kind: 'run_submitted', taskId: 'T-9', runNo: 'x', deliverable: { summary: 's' } } });
    }).not.toThrow();

    expect(remoteEvents).toEqual([
      { kind: 'run_submitted', taskId: 'T-9', runNo: 2, deliverable: { summary: '交付' } },
      { kind: 'request_created', request: { id: 'hr-1', sessionId: 's-1', kind: 'question' } },
    ]);
    expect(runner.activeTaskCount()).toBe(1);
    await runner.destroy();
  });

  it('畸形载荷（缺字段 / 非 object / 未知通道）→ 防御性丢弃不抛错、sink 不被调', async () => {
    const { child, emit } = mkFakeChild();
    const warmPool = new WarmPool({ spawn: () => Promise.resolve(child) });
    await warmPool.warm('inst1');
    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-x1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });
    await runner.executeTask({
      taskId: null,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-1',
    });

    const runEvents: TaskRunChangedEvent[] = [];
    const humanEvents: HumanChangedEvent[] = [];
    setTaskRunChangedSink((e) => runEvents.push(e));
    setHumanChangedSink((e) => humanEvents.push(e));

    expect(() => {
      emit({ type: 'lifecycle-event', channel: 'task:runChanged', payload: { taskId: 123 } }); // 字段缺 + 类型错
      emit({ type: 'lifecycle-event', channel: 'human:changed', payload: null }); // payload 非 object
      emit({ type: 'lifecycle-event', channel: 'human:changed' }); // payload 缺失
      emit({ type: 'lifecycle-event', channel: 'unknown-channel', payload: {} }); // 未知通道
      emit({ type: 'lifecycle-event', payload: {} }); // channel 缺失
    }).not.toThrow();
    expect(runEvents).toHaveLength(0);
    expect(humanEvents).toHaveLength(0);
    expect(runner.activeTaskCount()).toBe(1); // 消息处理后活跃 task 不受影响
    await runner.destroy();
  });
});
