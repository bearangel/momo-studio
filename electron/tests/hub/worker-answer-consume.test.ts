// electron/tests/hub/worker-answer-consume.test.ts
//
// 任务生命周期 v2 P2 S3 回归锁（spec 2026-11-13 §8.6 worker 侧消费）：
// hub 定向 task.interventionAnswered { taskId, interventionId, answer, answeredBy }
// → handleInterventionAnswered（remote-intervene-bridge）→ answerHuman 统一路由：
//   1) question pending → 行 answered（answer_json / answered_by='remote:<节点>'）
//      + 【人工答复】注入 + 唤醒（routeUserChat systemKickoff）
//   2) tool_gate pending + approve → 授权回调触发（grantWriteDirs + pending 清理）
//   3) 幂等双态：行不存在 → 静默不抛；行已 answered → 静默不改（首答保留）
//   4) 任务已终态 → answered 落库但不注入不唤醒（P1 stale 语义复用）
//   5) S2 顺手项回归：离线 client（state != online）→ 零 intervene 尝试 + 降级里程碑
//
// mock 边界（momo-test-rules #5）：事件入口（handler 直调——hub/index onEvent 仅
// 薄转发）/ router / push / deny 广播 / hub client mock；DB 真实
// （worker-intervene-bridge.test.ts 同款 AP_USER_DATA_DIR 临时库）。
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// router 边界打桩（lifecycle-runs-human.test.ts 同款）：唤醒链经 getRouterService
// 取单例，routeUserChat 仿真真实签名（返回 Promise）
const { routeUserChatMock, pushSessionMessageMock, mockBroadcastDeny } = vi.hoisted(() => ({
  routeUserChatMock: vi.fn<(input: unknown) => Promise<void>>(),
  pushSessionMessageMock: vi.fn<(msg: unknown) => void>(),
  mockBroadcastDeny: vi.fn((): boolean => false),
}));
vi.mock('../../src/main/agent/router-bootstrap', () => ({
  getRouterService: () => ({ routeUserChat: routeUserChatMock }),
}));
vi.mock('../../src/main/agent/stream-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/agent/stream-relay')>()),
  pushSessionMessage: (msg: unknown) => pushSessionMessageMock(msg),
}));

// electron API 假件（tool-gate-persistence.test.ts 同款——write-blocked 推卡边界）
const mockSend = vi.fn();
import { __setElectronApisForTest } from '../../src/main/electron-access';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, type TaskRow } from '../../src/main/storage/tasks/repo';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { getActiveRun } from '../../src/main/storage/tasks/runs-repo';
import { getHumanRequest, insertHumanRequest } from '../../src/main/storage/tasks/human-requests-repo';
import {
  setRemoteInterveneSink,
  requestHuman,
  startRun,
  submitRun,
  acceptTask,
  setToolGateHandler,
  setHumanAnswerKickoff,
} from '../../src/main/task/lifecycle-runs';
import { sendSystemKickoffMessage } from '../../src/main/task/human-answer-inject';
import {
  handleInterventionAnswered,
  createRemoteInterveneHandler,
  type RemoteInterveneBridgePorts,
  type RemoteInterveneEventInput,
} from '../../src/main/hub/remote-intervene-bridge';
import {
  writeBlockedFromChildMsg,
  listPendingWriteBlocked,
  handleToolGateAnswer,
  setWriteDeniedBroadcaster,
  __resetInspectStateForTest,
} from '../../src/main/sandbox/write-blocked-emit';
import { getGrantedDirs, __clearWriteGrantsForTest } from '../../src/main/sandbox/write-grant';
import type { HubClient } from '../../src/main/hub/client';

const SELF_NODE = 'node-self';
const REMOTE_ANSWERER = 'node-leader';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-worker-answer-consume-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

setWriteDeniedBroadcaster(mockBroadcastDeny);

beforeAll(() => {
  __setElectronApisForTest({
    BrowserWindow: {
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }],
    },
    ipcMain: { handle: vi.fn() },
  });
});
afterAll(() => {
  __setElectronApisForTest(null);
});

let execSessionId = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  execSessionId = insertSession({ workspaceId: 'ws1', title: '执行', kind: 'chat' }).id;
  setHumanAnswerKickoff(sendSystemKickoffMessage);
  __resetInspectStateForTest();
  __clearWriteGrantsForTest();
  routeUserChatMock.mockReset().mockResolvedValue(undefined);
  pushSessionMessageMock.mockClear();
  mockBroadcastDeny.mockClear();
  mockSend.mockClear();
});

afterEach(() => {
  setRemoteInterveneSink(null);
  setToolGateHandler(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 种 assigned 任务 + 活动 run（question/manual_action 消费面的本地执行态） */
function seedRunningTask(): { taskId: string; runId: string } {
  const t = insertTask({
    workspaceId: 'ws1',
    title: '委派任务',
    creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1',
    status: 'assigned',
    executionSessionId: execSessionId,
  });
  const run = startRun(t.id, { trigger: 'initial', executionSessionId: execSessionId });
  return { taskId: t.id, runId: run.id };
}

/** 会话种 leader 成员（唤醒目标——lifecycle-runs-human.test.ts 同款） */
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

/** 会话内 system 行（注入断言载体） */
function systemRows(sessionId: string): Array<{ sender: string; event_type: string; body: string }> {
  return getDb()
    .prepare(`SELECT sender, event_type, body FROM messages WHERE session_id = ? AND sender = 'system'`)
    .all(sessionId) as Array<{ sender: string; event_type: string; body: string }>;
}

/** 事件载荷（协议 TaskInterventionAnsweredEvent 形状） */
function answeredEvent(input: {
  interventionId: string;
  answer: Record<string, unknown>;
  taskId?: string;
  answeredBy?: string;
}): unknown {
  return {
    taskId: input.taskId ?? 'dl-hub-1',
    interventionId: input.interventionId,
    answer: input.answer,
    answeredBy: input.answeredBy ?? REMOTE_ANSWERER,
  };
}

// ── 1) question：注入 + 唤醒 ─────────────────────────────────────────────────

describe('1) question pending → answered + 注入【人工答复】+ 唤醒', () => {
  it('行 answered（answer_json/answered_by=remote:xxx）+ system 消息 + routeUserChat(systemKickoff)', () => {
    const { taskId, runId } = seedRunningTask();
    seedSessionLeader(execSessionId);
    const req = requestHuman({
      sessionId: execSessionId,
      kind: 'question',
      title: '确认方案',
      prompt: 'A 还是 B？',
      taskId,
      runId,
      optionsJson: JSON.stringify(['A', 'B']),
    });
    expect(getTask(taskId)!.status).toBe('waiting_human');

    handleInterventionAnswered(
      answeredEvent({ interventionId: req.id, answer: { selected: ['A'], text: '就用 A' } }),
    );

    const row = getHumanRequest(req.id)!;
    expect(row.status).toBe('answered');
    // 字段序非契约（映射器按 HumanAnswerInput 固定序重建）——按值断言
    expect(JSON.parse(row.answerJson!)).toEqual({ selected: ['A'], text: '就用 A' });
    expect(row.answeredByNodeId).toBe(`remote:${REMOTE_ANSWERER}`);
    expect(row.answeredAt).not.toBeNull();
    // 等人体恢复（P1 语义）
    expect(getTask(taskId)!.status).toBe('in_progress');
    expect(getActiveRun(taskId)!.status).toBe('running');
    // 注入 + 唤醒
    const sys = systemRows(execSessionId);
    expect(sys).toHaveLength(1);
    expect(sys[0]!.event_type).toBe('human_answer');
    expect(sys[0]!.body.startsWith('【人工答复】')).toBe(true);
    expect(sys[0]!.body).toContain('已选：A');
    expect(pushSessionMessageMock).toHaveBeenCalledTimes(1);
    expect(routeUserChatMock).toHaveBeenCalledTimes(1);
    expect(routeUserChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: execSessionId,
        assignmentId: 'inst-1',
        systemKickoff: true,
        body: sys[0]!.body,
      }),
    );
  });
});

// ── 2) tool_gate：授权回调 ───────────────────────────────────────────────────

describe('2) tool_gate pending + approve → 授权回调触发', () => {
  it('answerHuman → handleToolGateAnswer：grantWriteDirs 落账 + pending 清理 + 行 answered', () => {
    // 双写链真实形态（tool-gate-persistence.test.ts 同款）：归属消息行 + childMsg 上报
    const db = getDb();
    db.prepare(
      `INSERT INTO messages (id, session_id, sender, event_type, body, stream_session_id, status, source, created_at, updated_at)
       VALUES ('m-gate', ?, 'agent-coder', 'm.room.message', '', 'ss-gate', 'streaming', 'local', 1, 1)`,
    ).run(execSessionId);
    writeBlockedFromChildMsg({
      type: 'write-blocked-report',
      streamSessionId: 'ss-gate',
      workspaceId: 'ws1',
      dirs: ['/tmp/w-out'],
      command: 'mkdir -p out',
    });
    const row = getDb()
      .prepare(`SELECT id FROM human_requests WHERE kind = 'tool_gate' AND session_id = ?`)
      .get(execSessionId) as { id: string };
    expect(getHumanRequest(row.id)!.status).toBe('pending');
    expect(listPendingWriteBlocked(execSessionId)).toHaveLength(1);

    setToolGateHandler(handleToolGateAnswer);
    handleInterventionAnswered(
      answeredEvent({ interventionId: row.id, answer: { decision: 'approve' } }),
    );

    expect(getHumanRequest(row.id)!.status).toBe('answered');
    expect(getHumanRequest(row.id)!.answeredByNodeId).toBe(`remote:${REMOTE_ANSWERER}`);
    expect(getGrantedDirs(execSessionId, null)).toContain('/tmp/w-out');
    expect(listPendingWriteBlocked(execSessionId)).toHaveLength(0);
    expect(mockBroadcastDeny).not.toHaveBeenCalled(); // approve 不走 deny 广播
  });
});

// ── 3) 幂等双态 ──────────────────────────────────────────────────────────────

describe('3) 幂等双态：不存在 / 已 answered → 静默', () => {
  it('行不存在 → 不抛、零副作用', () => {
    expect(() =>
      handleInterventionAnswered(
        answeredEvent({ interventionId: 'req-nope', answer: { text: 'x' } }),
      ),
    ).not.toThrow();
    expect(routeUserChatMock).not.toHaveBeenCalled();
    expect(pushSessionMessageMock).not.toHaveBeenCalled();
  });

  it('行已 answered → 静默不改（首答保留，零重复注入）', () => {
    const { taskId, runId } = seedRunningTask();
    seedSessionLeader(execSessionId);
    const req = requestHuman({
      sessionId: execSessionId,
      kind: 'question',
      title: '确认方案',
      prompt: '继续吗',
      taskId,
      runId,
    });
    handleInterventionAnswered(answeredEvent({ interventionId: req.id, answer: { text: '继续' } }));
    expect(systemRows(execSessionId)).toHaveLength(1);

    // 迟到重放（本地已答 / hub first_wins 后的重复投递形态）
    handleInterventionAnswered(answeredEvent({ interventionId: req.id, answer: { text: '再想想' } }));

    const row = getHumanRequest(req.id)!;
    expect(row.status).toBe('answered');
    expect(row.answerJson).toBe(JSON.stringify({ text: '继续' })); // 首答保留
    expect(systemRows(execSessionId)).toHaveLength(1); // 零重复注入
    expect(routeUserChatMock).toHaveBeenCalledTimes(1); // 零重复唤醒
  });

  it('异形载荷（answer 字段类型错 / interventionId 缺席）→ 静默不消费', () => {
    const { taskId, runId } = seedRunningTask();
    const req = requestHuman({
      sessionId: execSessionId,
      kind: 'question',
      title: '确认',
      prompt: '继续吗',
      taskId,
      runId,
    });
    handleInterventionAnswered({
      taskId: 'dl-x',
      interventionId: req.id,
      answer: { decision: 'yes' }, // 非法 decision
      answeredBy: REMOTE_ANSWERER,
    });
    handleInterventionAnswered({ taskId: 'dl-x', answer: {}, answeredBy: REMOTE_ANSWERER });
    expect(getHumanRequest(req.id)!.status).toBe('pending'); // 未被消费
  });
});

// ── 4) 任务已终态：answered 落库但不注入不唤醒（P1 stale 语义复用）──────────

describe('4) 任务已终态 → 落库不注入不唤醒', () => {
  it('completed 后代答到达 → answered 但零 system 消息零 routeUserChat', async () => {
    const { taskId } = seedRunningTask();
    seedSessionLeader(execSessionId);
    // 窗口形态请求（不绑 run——submitRun 未决闸不顶替，全程 pending）
    insertHumanRequest({
      sessionId: execSessionId,
      kind: 'question',
      title: '窗口请求',
      prompt: '确认吗',
      taskId,
      runId: null,
    });
    const reqId = (
      getDb()
        .prepare(`SELECT id FROM human_requests WHERE title = '窗口请求'`)
        .get() as { id: string }
    ).id;

    await submitRun(taskId, { summary: '交付' });
    await acceptTask(taskId);
    expect(getTask(taskId)!.status).toBe('completed');
    expect(getHumanRequest(reqId)!.status).toBe('pending');

    handleInterventionAnswered(answeredEvent({ interventionId: reqId, answer: { text: '迟到答复' } }));

    expect(getHumanRequest(reqId)!.status).toBe('answered'); // 落库
    expect(getHumanRequest(reqId)!.answeredByNodeId).toBe(`remote:${REMOTE_ANSWERER}`);
    expect(systemRows(execSessionId)).toHaveLength(0); // 零注入
    expect(routeUserChatMock).not.toHaveBeenCalled(); // 零唤醒
    expect(pushSessionMessageMock).not.toHaveBeenCalled();
  });
});

// ── 5) S2 顺手项回归：离线 client 零 intervene 尝试 ──────────────────────────

describe('5) S2 离线预检：state != online → 零 intervene 尝试', () => {
  /** fake hub client（worker-intervene-bridge.test.ts 同款缩小面） */
  function mkOfflineClient(): HubClient {
    return {
      start: () => undefined,
      stop: () => undefined,
      state: () => 'disconnected' as const,
      hubProtoVer: () => '1.11.0',
      request: vi.fn(async () => ({ interventionId: 'x' })) as unknown as HubClient['request'],
      sendRes: vi.fn(() => true),
    } as HubClient;
  }

  it('client 非 online → 零 task.intervene RPC + 降级里程碑 + 行保留 pending', async () => {
    const client = mkOfflineClient();
    const ports: RemoteInterveneBridgePorts = {
      clientGetter: () => client,
      selfNodeId: () => SELF_NODE,
      getTask: (id) => getTask(id),
      getActiveRun: (id) => getActiveRun(id),
      findActiveTaskByExecutionSession: () => null,
      acceptTask: async () => undefined,
    };
    setRemoteInterveneSink(createRemoteInterveneHandler(ports));

    const t = insertTask({
      workspaceId: 'ws1',
      title: '委派任务',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-1',
      status: 'assigned',
      executionSessionId: execSessionId,
      delegationId: 'dl-off',
      routing: { mode: 'node', groupId: 'g-1', targetNodeId: SELF_NODE },
    });
    const run = startRun(t.id, { trigger: 'initial', executionSessionId: execSessionId });
    const req = requestHuman({
      sessionId: execSessionId,
      kind: 'question',
      title: '需要确认',
      prompt: '选 A',
      taskId: t.id,
      runId: run.id,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(client.request).not.toHaveBeenCalled(); // 零 intervene 尝试
    expect(getHumanRequest(req.id)!.status).toBe('pending'); // 本地等待降级
    const milestone = getDb()
      .prepare(`SELECT body FROM messages WHERE event_type = 'delegation_milestone'`)
      .all() as Array<{ body: string }>;
    expect(milestone).toHaveLength(1);
    expect(milestone[0]!.body).toContain('干预上报降级');
  });
});
