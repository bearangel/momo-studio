// electron/tests/hub/worker-steer-consume.test.ts
//
// 任务生命周期 v2 P3 S1 回归锁（spec 2026-11-13 §8.2 steer 槽位 / §8.6 worker 侧）：
// hub 定向 task.steered { taskId, message } → handleTaskSteered（remote-intervene-bridge）：
//   1) 注入到达：里程碑 kind='steered' 系统消息（【发起方指令】前缀 + message 摘要
//      meta）+ pushSessionMessage + routeUserChat（**不带 systemKickoff**——steer
//      分流语义：有在途流注入当前流不撕裂（RF#1）、无在途回合回退开新回合；
//      streamSessionId 与里程碑行共享 = 回合标识）
//   2) 去重窗口：同 delegation 同文 10s 内重发 → 静默丢弃；异文/窗口外照常消费
//   3) 幂等静默：无本机承接行 / 外派镜像行 / 任务终态 → 零注入零唤醒
//   4) 无执行会话 → warn 跳过（零写入）；无 leader 接待目标 → 里程碑照落、唤醒跳过
//
// mock 边界（momo-test-rules #5，worker-answer-consume.test.ts 同款）：事件入口
// （handler 直调——hub/index onEvent 仅薄转发）/ router / push；DB 真实
// （AP_USER_DATA_DIR 临时库）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// router 边界打桩（worker-answer-consume.test.ts 同款）：注入链经 getRouterService
// 取单例，routeUserChat 仿真真实签名（返回 Promise）
const { routeUserChatMock, pushSessionMessageMock } = vi.hoisted(() => ({
  routeUserChatMock: vi.fn<(input: unknown) => Promise<void>>(),
  pushSessionMessageMock: vi.fn<(msg: unknown) => void>(),
}));
vi.mock('../../src/main/agent/router-bootstrap', () => ({
  getRouterService: () => ({ routeUserChat: routeUserChatMock }),
}));
vi.mock('../../src/main/agent/stream-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/agent/stream-relay')>()),
  pushSessionMessage: (msg: unknown) => pushSessionMessageMock(msg),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { acceptTask, startRun, submitRun } from '../../src/main/task/lifecycle-runs';
import {
  handleTaskSteered,
  __resetSteerDedupeForTest,
  type TaskSteeredConsumePorts,
} from '../../src/main/hub/remote-intervene-bridge';

const SELF_NODE = 'node-self';
const DELEGATION_ID = 'dl-steer-1';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-worker-steer-consume-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

let execSessionId = '';
const ports: TaskSteeredConsumePorts = { selfNodeId: () => SELF_NODE };

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  execSessionId = insertSession({ workspaceId: 'ws1', title: '执行', kind: 'chat' }).id;
  __resetSteerDedupeForTest();
  routeUserChatMock.mockReset().mockResolvedValue(undefined);
  pushSessionMessageMock.mockClear();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 种 worker 承接行（classic 'in'：delegation_id + delegation_role）+ 可选执行会话 */
function seedWorkerTask(opts: { executionSessionId?: string; delegationId?: string } = {}): string {
  const t = insertTask({
    workspaceId: 'ws1',
    title: '委派任务',
    creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1',
    status: 'assigned',
    ...(opts.executionSessionId !== undefined
      ? { executionSessionId: opts.executionSessionId }
      : {}),
    delegationId: opts.delegationId ?? DELEGATION_ID,
  });
  getDb().prepare(`UPDATE tasks SET delegation_role = 'in' WHERE id = ?`).run(t.id);
  return t.id;
}

/** 会话种 leader 成员（唤醒目标——worker-answer-consume.test.ts 同款） */
function seedSessionLeader(sessionId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, icon_emoji)
     VALUES ('def-1', 'Worker', 'worker', '1', 'p', 'm', '🤖')`,
  ).run();
  db.prepare(
    `INSERT INTO workspace_agent_members
       (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
     VALUES ('inst-1', 'ws1', 'def-1', '@inst-1:s', 1)`,
  ).run();
  addSessionMember(sessionId, 'inst-1', true);
}

/** 执行会话 delegation_milestone 行（注入断言载体） */
function milestoneRows(
  sessionId: string,
): Array<{ sender: string; body: string; task_id: string; stream_session_id: string; context_json: string }> {
  return getDb()
    .prepare(
      `SELECT sender, body, task_id, stream_session_id, context_json FROM messages
       WHERE session_id = ? AND event_type = 'delegation_milestone'`,
    )
    .all(sessionId) as Array<{
    sender: string;
    body: string;
    task_id: string;
    stream_session_id: string;
    context_json: string;
  }>;
}

/** 事件载荷（协议 TaskSteeredEvent 形状 { taskId, message }） */
function steeredEvent(taskId: string, message: string): unknown {
  return { taskId, message };
}

// ── 1) 注入到达：里程碑 + steer 分流路由 ─────────────────────────────────────

describe('1) 注入到达：里程碑 kind=steered + routeUserChat（不带 systemKickoff）', () => {
  it('running 承接行 → delegation_milestone 系统消息（【发起方指令】前缀 + 摘要 meta）+ push + 路由（steer 分流语义）', () => {
    const taskId = seedWorkerTask({ executionSessionId: execSessionId });
    seedSessionLeader(execSessionId);
    startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    expect(getTask(taskId)!.status).toBe('in_progress');

    expect(() => handleTaskSteered(steeredEvent(DELEGATION_ID, '请改用方案 B'), ports)).not.toThrow();

    const rows = milestoneRows(execSessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sender).toBe('system');
    expect(rows[0]!.body).toBe('【发起方指令】请改用方案 B');
    expect(rows[0]!.task_id).toBe(taskId);
    expect(JSON.parse(rows[0]!.context_json)).toEqual({ kind: 'steered', message: '请改用方案 B' });
    expect(pushSessionMessageMock).toHaveBeenCalledTimes(1);

    // RF#1 语义锁：不走无条件 systemKickoff（RouterService 无 kickoff 排队——
    // 回合进行中 systemKickoff 会开并行 ephemeral 回合撕裂在途流）；steer 分流
    // 由 routeUserChat 内部分支承载（有车道注入当前流、无车道回退开新回合）
    expect(routeUserChatMock).toHaveBeenCalledTimes(1);
    const call = routeUserChatMock.mock.calls[0]![0] as {
      sessionId: string;
      assignmentId: string;
      body: string;
      streamSessionId?: string;
      sourceTaskId?: string | null;
      systemKickoff?: boolean;
    };
    expect(call.sessionId).toBe(execSessionId);
    expect(call.assignmentId).toBe('inst-1');
    expect(call.body).toBe('【发起方指令】请改用方案 B');
    expect(call.sourceTaskId).toBe(taskId);
    expect(call.systemKickoff).toBeUndefined();
    // 回合标识共享：里程碑行与派发回合同一 streamSessionId（human-answer 同构）
    expect(call.streamSessionId).toBe(rows[0]!.stream_session_id);
  });

  it('message 摘要超 80 字截断（meta 上限）；正文全量落 body', () => {
    const taskId = seedWorkerTask({ executionSessionId: execSessionId });
    seedSessionLeader(execSessionId);
    const long = '长'.repeat(120);

    handleTaskSteered(steeredEvent(DELEGATION_ID, long), ports);

    const rows = milestoneRows(execSessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe(`【发起方指令】${long}`);
    const meta = JSON.parse(rows[0]!.context_json) as { kind: string; message: string };
    expect(meta.kind).toBe('steered');
    expect(meta.message).toHaveLength(80); // 79 字 + 省略号（truncateCodePoints 追加 '…'）
  });

  it('无 leader 接待目标 → 里程碑照落推送、唤醒跳过（warn 不抛）', () => {
    seedWorkerTask({ executionSessionId: execSessionId });

    handleTaskSteered(steeredEvent(DELEGATION_ID, '请改用方案 B'), ports);

    expect(milestoneRows(execSessionId)).toHaveLength(1);
    expect(pushSessionMessageMock).toHaveBeenCalledTimes(1);
    expect(routeUserChatMock).not.toHaveBeenCalled();
  });
});

// ── 2) 去重窗口：delegation_id + message hash + 10s ──────────────────────────

describe('2) 去重窗口：同文 10s 内静默、异文/窗口外照常消费', () => {
  it('同 delegation 同文重发 → 单次注入；异文不受影响', () => {
    const taskId = seedWorkerTask({ executionSessionId: execSessionId });
    seedSessionLeader(execSessionId);

    handleTaskSteered(steeredEvent(DELEGATION_ID, '同一条指令'), ports);
    handleTaskSteered(steeredEvent(DELEGATION_ID, '同一条指令'), ports); // 窗口内重放
    handleTaskSteered(steeredEvent(DELEGATION_ID, '另一条指令'), ports); // 异文放行

    expect(milestoneRows(execSessionId)).toHaveLength(2);
    expect(routeUserChatMock).toHaveBeenCalledTimes(2);
    expect(getTask(taskId)!.status).toBe('assigned'); // 消费零状态副作用（纯指令）
  });

  it('窗口过期后同文重发 → 再次消费（真意重复在窗口外有效）', () => {
    seedWorkerTask({ executionSessionId: execSessionId });
    seedSessionLeader(execSessionId);
    const nowSpy = vi.spyOn(Date, 'now');

    const t0 = 1_700_000_000_000;
    nowSpy.mockReturnValue(t0);
    handleTaskSteered(steeredEvent(DELEGATION_ID, '同一条指令'), ports);
    nowSpy.mockReturnValue(t0 + 10_001); // 越过 10s 窗口
    handleTaskSteered(steeredEvent(DELEGATION_ID, '同一条指令'), ports);

    expect(milestoneRows(execSessionId)).toHaveLength(2);
    expect(routeUserChatMock).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('不同 delegation 同文互不去重（键含 delegation_id）', () => {
    const t1 = seedWorkerTask({ executionSessionId: execSessionId, delegationId: 'dl-a' });
    const t2 = seedWorkerTask({ executionSessionId: execSessionId, delegationId: 'dl-b' });
    seedSessionLeader(execSessionId);
    getDb().prepare(`UPDATE tasks SET delegation_role = 'in' WHERE id = ?`).run(t2);

    handleTaskSteered(steeredEvent('dl-a', '同文指令'), ports);
    handleTaskSteered(steeredEvent('dl-b', '同文指令'), ports);

    expect(milestoneRows(execSessionId)).toHaveLength(2);
  });
});

// ── 3) 幂等静默：无承接行 / 镜像行 / 终态 ────────────────────────────────────

describe('3) 幂等静默：无本机承接行 / 外派镜像行 / 已终态 → 零注入零唤醒', () => {
  it('delegation_id 无承接行 → 静默不抛零副作用', () => {
    expect(() => handleTaskSteered(steeredEvent('dl-unknown', '指令'), ports)).not.toThrow();
    expect(milestoneRows(execSessionId)).toHaveLength(0);
    expect(routeUserChatMock).not.toHaveBeenCalled();
    expect(pushSessionMessageMock).not.toHaveBeenCalled();
  });

  it('外派镜像行（delegation_role=out）不消费——worker 判向', () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: '外派镜像',
      creatorUserId: '@owner:home',
      status: 'assigned',
      executionSessionId: execSessionId,
      delegationId: DELEGATION_ID,
    });
    getDb().prepare(`UPDATE tasks SET delegation_role = 'out' WHERE id = ?`).run(t.id);

    handleTaskSteered(steeredEvent(DELEGATION_ID, '指令'), ports);

    expect(milestoneRows(execSessionId)).toHaveLength(0);
    expect(routeUserChatMock).not.toHaveBeenCalled();
  });

  it('任务已终态（completed）→ 静默丢弃', async () => {
    const taskId = seedWorkerTask({ executionSessionId: execSessionId });
    seedSessionLeader(execSessionId);
    startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    await submitRun(taskId, { summary: '交付' });
    await acceptTask(taskId);
    expect(getTask(taskId)!.status).toBe('completed');

    handleTaskSteered(steeredEvent(DELEGATION_ID, '迟到指令'), ports);

    expect(milestoneRows(execSessionId)).toHaveLength(0);
    expect(routeUserChatMock).not.toHaveBeenCalled();
    expect(pushSessionMessageMock).not.toHaveBeenCalled();
  });

  it('异形载荷（message 缺席 / 纯空白 / taskId 非串）→ 静默不消费', () => {
    seedWorkerTask({ executionSessionId: execSessionId });
    handleTaskSteered({ taskId: DELEGATION_ID }, ports);
    handleTaskSteered({ taskId: DELEGATION_ID, message: '   ' }, ports);
    handleTaskSteered({ taskId: 42, message: 'x' }, ports);
    handleTaskSteered(null, ports);
    expect(milestoneRows(execSessionId)).toHaveLength(0);
    expect(routeUserChatMock).not.toHaveBeenCalled();
  });
});

// ── 4) 无执行会话 → warn 跳过 ────────────────────────────────────────────────

describe('4) 无执行会话：execution_session_id 空 → 零写入零唤醒', () => {
  it('承接行无会话 → 里程碑不落、路由不发（无会话可注入）', () => {
    seedWorkerTask({ executionSessionId: '' });

    handleTaskSteered(steeredEvent(DELEGATION_ID, '无处可去的指令'), ports);

    expect(milestoneRows(execSessionId)).toHaveLength(0);
    expect(pushSessionMessageMock).not.toHaveBeenCalled();
    expect(routeUserChatMock).not.toHaveBeenCalled();
  });
});
