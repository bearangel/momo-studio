// electron/tests/hub/reconnect-reconcile.test.ts
//
// 任务生命周期 v2 P2 S7 回归锁（spec 2026-11-13 §8.6 断连窗口补偿）：
// 重连对账 reconcileOnReconnect（hub/index onStateChange(online) 装配）：
//   1) worker 断线期 answered → task.interventions {} 补应用（S3 同一函数——
//      行 answered + 注入【人工答复】+ 唤醒 routeUserChat systemKickoff）
//   2) 发起方断线期 pending → 补镜像行 + 里程碑（S5 语义，UNIQUE 幂等键）；
//      answered → 镜像行 tryAnswer 收敛（不注入不唤醒——唤醒在 worker 侧）
//   3) 幂等：二次对账零重复（行/里程碑计数不变，首答保留）
//   4) submitted 漏事件补收（task.list → S5 镜像语义，remote_id 幂等键）
//   5) 对账 RPC 失败 → logger.warn 不抛不阻塞（fire-and-forget 装配语义）
//   6) findTaskByDelegationId 角色限定（S4 review Minor#1——S7 落地）：
//      自委派双行共存（'out' 镜像 + 'in' 承接共享 delegation_id）时
//      worker 消费取 'in'、发起方镜像取 'out'，消除任意取行
//
// mock 边界（momo-test-rules #5）：hub client fake（request 按 method/payload
// 分发快照）/ router / push / deny 广播 / human:changed sink spy；DB 真实
// （worker-answer-consume.test.ts 同款 AP_USER_DATA_DIR 临时库）。
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// router 边界打桩（worker-answer-consume.test.ts 同款）：唤醒链经 getRouterService
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

// electron API 假件（worker-answer-consume.test.ts 同款）
const mockSend = vi.fn();
import { __setElectronApisForTest } from '../../src/main/electron-access';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, updateTask, getTask } from '../../src/main/storage/tasks/repo';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { getActiveRun } from '../../src/main/storage/tasks/runs-repo';
import { getHumanRequest, insertHumanRequest, findRemoteMirrorRequest } from '../../src/main/storage/tasks/human-requests-repo';
import {
  requestHuman,
  startRun,
  submitRun,
  setHumanAnswerKickoff,
  setHumanChangedSink,
  type HumanChangedEvent,
} from '../../src/main/task/lifecycle-runs';
import { sendSystemKickoffMessage } from '../../src/main/task/human-answer-inject';
import { reconcileOnReconnect } from '../../src/main/hub/reconnect-reconcile';
import { handleTaskAccepted, handleTaskSubmittedMirror } from '../../src/main/hub/remote-intervene-bridge';
import { TASK_RPC, type InterventionRecord, type TaskRecord } from '../../src/main/hub/protocol';
import { setWriteDeniedBroadcaster } from '../../src/main/sandbox/write-blocked-emit';
import type { HubClient } from '../../src/main/hub/client';

const SELF_NODE = 'node-self';
const WORKER_NODE = 'node-worker';
const DELEGATION_ID = 'dl-recon-1';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-reconnect-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
let originSessionId = '';
const humanEvents: HumanChangedEvent[] = [];
const humanSinkSpy = vi.fn((e: HumanChangedEvent) => humanEvents.push(e));

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  execSessionId = insertSession({ workspaceId: 'ws1', title: '执行', kind: 'chat' }).id;
  originSessionId = insertSession({ workspaceId: 'ws1', title: '跟踪', kind: 'chat' }).id;
  setHumanAnswerKickoff(sendSystemKickoffMessage);
  humanEvents.length = 0;
  humanSinkSpy.mockClear();
  setHumanChangedSink(humanSinkSpy);
  routeUserChatMock.mockReset().mockResolvedValue(undefined);
  pushSessionMessageMock.mockClear();
  mockBroadcastDeny.mockClear();
  mockSend.mockClear();
});

afterEach(() => {
  setHumanChangedSink(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 种 worker 承接任务 + 活动 run（peer-draft 承接形：role NULL + routing 指向本机） */
function seedWorkerTask(): { taskId: string; runId: string } {
  const t = insertTask({
    workspaceId: 'ws1',
    title: '承接任务',
    creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1',
    status: 'assigned',
    executionSessionId: execSessionId,
    delegationId: DELEGATION_ID,
    routing: { mode: 'node', groupId: 'g-1', targetNodeId: SELF_NODE },
  });
  const run = startRun(t.id, { trigger: 'initial', executionSessionId: execSessionId });
  return { taskId: t.id, runId: run.id };
}

/** 种发起方外派行（'out' + 跟踪会话 + routing 回写执行节点——镜像行 origin 锚）。
 *  delegation_role 不在 insertTask 列集（生产由 dispatch-submit 回执 updateTask 补戳）——同款补戳。 */
function seedOriginTask(): string {
  const t = insertTask({
    workspaceId: 'ws1',
    title: '外派任务',
    creatorUserId: '@owner:home',
    status: 'pending',
    executionSessionId: originSessionId,
    delegationId: DELEGATION_ID,
    routing: { mode: 'node', groupId: 'g-1', targetNodeId: WORKER_NODE },
  });
  updateTask(t.id, { delegationRole: 'out' });
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

function systemRows(sessionId: string): Array<{ sender: string; event_type: string; body: string }> {
  return getDb()
    .prepare(`SELECT sender, event_type, body FROM messages WHERE session_id = ? AND sender = 'system'`)
    .all(sessionId) as Array<{ sender: string; event_type: string; body: string }>;
}

function milestoneCount(): number {
  return (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE event_type = 'delegation_milestone'`)
      .get() as { n: number }
  ).n;
}

/** hub 干预账本行快照（协议 InterventionRecord 投影形状） */
function rec(overrides: Partial<InterventionRecord> & Pick<InterventionRecord, 'interventionId' | 'kind' | 'status'>): InterventionRecord {
  return {
    runNo: 1,
    title: '确认方案',
    prompt: 'A 还是 B？',
    createdAt: Date.now() - 60_000,
    ...overrides,
  };
}

/** fake hub client：request 按 method/payload 分发快照；fail=true 模拟对账 RPC 全挂 */
function mkClient(snapshot: {
  all?: InterventionRecord[];
  byTask?: Record<string, InterventionRecord[]>;
  submitted?: TaskRecord[];
  fail?: boolean;
}): HubClient {
  return {
    start: () => undefined,
    stop: () => undefined,
    state: () => 'online',
    hubProtoVer: () => '1.11.0',
    sendRes: () => true,
    request: vi.fn(async (method: string, payload: unknown) => {
      if (snapshot.fail) throw new Error('hub rpc down');
      if (method === TASK_RPC.interventions) {
        const p = payload as { taskId?: string } | null;
        if (p && typeof p.taskId === 'string') {
          return { interventions: snapshot.byTask?.[p.taskId] ?? [] };
        }
        return { interventions: snapshot.all ?? [] };
      }
      if (method === TASK_RPC.list) return { tasks: snapshot.submitted ?? [] };
      throw new Error(`unexpected rpc method: ${method}`);
    }),
  } as unknown as HubClient;
}

// ── 1) worker 断线期 answered → 补应用（S3 断言面）────────────────────────────

describe('1) worker 断线期 answered → 重连对账应用', () => {
  it('行 answered + answer_json/answered_by=remote:xxx + 注入【人工答复】+ 唤醒（S3 同款）', async () => {
    const { taskId } = seedWorkerTask();
    seedSessionLeader(execSessionId);
    const req = requestHuman({
      sessionId: execSessionId,
      kind: 'question',
      title: '确认方案',
      prompt: 'A 还是 B？',
      taskId,
      runId: getActiveRun(taskId)!.id,
      optionsJson: JSON.stringify(['A', 'B']),
    });
    expect(getTask(taskId)!.status).toBe('waiting_human');

    // 断线形态：本地行 pending、hub 账本已 answered（答方=发起方节点）
    await reconcileOnReconnect({
      client: mkClient({
        all: [
          rec({
            interventionId: req.id,
            kind: 'question',
            status: 'answered',
            answer: { selected: ['A'], text: '就用 A' },
            answeredBy: 'node-leader',
            answeredAt: Date.now(),
          }),
        ],
      }),
    });

    const row = getHumanRequest(req.id)!;
    expect(row.status).toBe('answered');
    expect(JSON.parse(row.answerJson!)).toEqual({ selected: ['A'], text: '就用 A' });
    expect(row.answeredByNodeId).toBe('remote:node-leader');
    expect(getTask(taskId)!.status).toBe('in_progress'); // 等人体恢复
    const sys = systemRows(execSessionId);
    expect(sys).toHaveLength(1);
    expect(sys[0]!.event_type).toBe('human_answer');
    expect(sys[0]!.body.startsWith('【人工答复】')).toBe(true);
    expect(routeUserChatMock).toHaveBeenCalledTimes(1);
    expect(routeUserChatMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: execSessionId, systemKickoff: true }),
    );
  });
});

// ── 2) 发起方断线期：pending 补镜像 / answered 镜像行收敛 ─────────────────────

describe('2) 发起方断线期 pending → 补镜像 + 里程碑', () => {
  it('镜像行落库（origin/remote 幂等键）+ human:changed inserted + 里程碑 remote_intervention；任务态不动', async () => {
    const originTaskId = seedOriginTask();

    await reconcileOnReconnect({
      client: mkClient({
        byTask: {
          [DELEGATION_ID]: [
            rec({ interventionId: 'iv-remote-1', kind: 'tool_gate', status: 'pending', title: '写授权：cargo build' }),
          ],
        },
      }),
    });

    const mirror = findRemoteMirrorRequest(WORKER_NODE, 'iv-remote-1');
    expect(mirror).not.toBeNull();
    expect(mirror!.kind).toBe('tool_gate');
    expect(mirror!.status).toBe('pending');
    expect(mirror!.sessionId).toBe(originSessionId);
    expect(mirror!.taskId).toBe(originTaskId);
    expect(getTask(originTaskId)!.status).toBe('pending'); // 任务态不动（等待角标由镜像行派生）
    expect(humanEvents).toContainEqual({ sessionId: originSessionId, requestId: mirror!.id, kind: 'inserted' });
    expect(milestoneCount()).toBe(1);
  });

  it('answered 且本地镜像行 pending → tryAnswer 收敛（answered_by=remote:xxx）不注入不唤醒', async () => {
    const originTaskId = seedOriginTask();
    const mirror = insertHumanRequest({
      sessionId: originSessionId,
      taskId: originTaskId,
      kind: 'question',
      title: '确认方案',
      prompt: '继续吗',
      delegationId: DELEGATION_ID,
      originNodeId: WORKER_NODE,
      remoteId: 'iv-remote-2',
    });

    await reconcileOnReconnect({
      client: mkClient({
        byTask: {
          [DELEGATION_ID]: [
            rec({
              interventionId: 'iv-remote-2',
              kind: 'question',
              status: 'answered',
              answer: { text: '继续' },
              answeredBy: 'node-other-leader',
              answeredAt: Date.now(),
            }),
          ],
        },
      }),
    });

    const after = getHumanRequest(mirror.id)!;
    expect(after.status).toBe('answered');
    expect(JSON.parse(after.answerJson!)).toEqual({ text: '继续' });
    expect(after.answeredByNodeId).toBe('remote:node-other-leader');
    expect(humanEvents).toContainEqual({ sessionId: originSessionId, requestId: mirror.id, kind: 'answered' });
    expect(systemRows(originSessionId)).toHaveLength(0); // 发起方不注入
    expect(routeUserChatMock).not.toHaveBeenCalled(); // 不唤醒
    expect(milestoneCount()).toBe(0); // 收敛不打里程碑
  });
});

// ── 3) 幂等：二次对账零重复 ───────────────────────────────────────────────────

describe('3) 幂等：二次对账零重复', () => {
  it('同快照重跑：镜像行/里程碑计数不变；answered 首答保留', async () => {
    const originTaskId = seedOriginTask();
    const mirror = insertHumanRequest({
      sessionId: originSessionId,
      taskId: originTaskId,
      kind: 'question',
      title: '确认方案',
      prompt: '继续吗',
      delegationId: DELEGATION_ID,
      originNodeId: WORKER_NODE,
      remoteId: 'iv-dup-1',
    });
    const snapshot = {
      all: [] as InterventionRecord[],
      byTask: {
        [DELEGATION_ID]: [
          rec({ interventionId: 'iv-dup-2', kind: 'question', status: 'pending' }),
          rec({
            interventionId: 'iv-dup-1',
            kind: 'question',
            status: 'answered',
            answer: { text: '首答' },
            answeredBy: 'node-leader',
            answeredAt: Date.now(),
          }),
        ],
      },
    };
    const deps = { client: mkClient(snapshot) };
    await reconcileOnReconnect(deps);
    expect(milestoneCount()).toBe(1); // pending 补镜像落一条
    const answeredRow = getHumanRequest(mirror.id)!;
    expect(answeredRow.status).toBe('answered');

    await reconcileOnReconnect(deps);

    expect(milestoneCount()).toBe(1); // 镜像行已存在 → 里程碑判重跳过
    expect(
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM human_requests WHERE origin_node_id = ?`)
        .get(WORKER_NODE),
    ).toEqual({ n: 2 }); // 镜像行不重复（收敛行 + 补镜像行各一）
    expect(JSON.parse(getHumanRequest(mirror.id)!.answerJson!)).toEqual({ text: '首答' }); // 首答保留
  });
});

// ── 4) submitted 漏事件补收（S5 键幂等）──────────────────────────────────────

describe('4) submitted 漏事件补收', () => {
  it('task.list 见 submitted 而本地非 submitted → run 懒建 + 行态直写 + acceptance 镜像行（remote_id 幂等键）', async () => {
    const originTaskId = seedOriginTask();
    const deps = {
      client: mkClient({
        submitted: [
          {
            taskId: DELEGATION_ID,
            workspaceName: 'Test',
            targetNodeId: WORKER_NODE,
            status: 'submitted',
            title: '外派任务',
            createdAt: Date.now() - 1000,
            updatedAt: Date.now(),
            runNo: 2,
          },
        ],
      }),
    };
    await reconcileOnReconnect(deps);

    const t = getTask(originTaskId)!;
    expect(t.status).toBe('submitted');
    expect(t.currentRunId).not.toBeNull();
    const acc = findRemoteMirrorRequest(WORKER_NODE, `${DELEGATION_ID}#2`);
    expect(acc).not.toBeNull();
    expect(acc!.kind).toBe('acceptance');
    expect(milestoneCount()).toBe(1);

    // 二次对账：镜像行存在 → 整单跳过（零重复行/里程碑）
    await reconcileOnReconnect(deps);
    expect(milestoneCount()).toBe(1);
    expect(
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM human_requests WHERE kind = 'acceptance'`)
        .get(),
    ).toEqual({ n: 1 });
  });
});

// ── 5) 对账 RPC 失败不阻塞 ───────────────────────────────────────────────────

describe('5) 对账 RPC 失败容忍', () => {
  it('三阶段 RPC 全挂 → 不抛、本地零变更', async () => {
    const { taskId } = seedWorkerTask();
    const req = requestHuman({
      sessionId: execSessionId,
      kind: 'question',
      title: '确认方案',
      prompt: '继续吗',
      taskId,
      runId: getActiveRun(taskId)!.id,
    });

    await expect(
      reconcileOnReconnect({ client: mkClient({ fail: true }) }),
    ).resolves.toBeUndefined();

    expect(getHumanRequest(req.id)!.status).toBe('pending'); // 零变更（下次重连再对账）
    expect(systemRows(execSessionId)).toHaveLength(0);
    expect(milestoneCount()).toBe(0);
  });
});

// ── 6) findTaskByDelegationId 角色限定（S4 review Minor#1——S7 落地）─────────

describe('6) 自委派双行共存：worker 消费取 in、发起方镜像取 out', () => {
  it('handleTaskAccepted 落 in 行；handleTaskSubmittedMirror 落 out 行（互不串扰）', async () => {
    // 同 delegation_id 双行：'in' 承接行 + 'out' 镜像行（同节点自委派形态）
    const worker = insertTask({
      workspaceId: 'ws1',
      title: '承接行',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-1',
      status: 'assigned',
      executionSessionId: execSessionId,
      delegationId: DELEGATION_ID,
    });
    updateTask(worker.id, { delegationRole: 'in' });
    const origin = insertTask({
      workspaceId: 'ws1',
      title: '外派镜像行',
      creatorUserId: '@owner:home',
      status: 'pending',
      executionSessionId: originSessionId,
      delegationId: DELEGATION_ID,
      routing: { mode: 'node', groupId: 'g-1', targetNodeId: SELF_NODE }, // 自委派：目标即本机
    });
    updateTask(origin.id, { delegationRole: 'out' });
    startRun(worker.id, { trigger: 'initial', executionSessionId: execSessionId });
    await submitRun(worker.id, { summary: '交付' });
    expect(getTask(worker.id)!.status).toBe('submitted');

    // worker 侧验收消费 → 'in' 行收口 completed；'out' 行不动
    await handleTaskAccepted({ taskId: DELEGATION_ID, runNo: 1 }, {
      selfNodeId: () => SELF_NODE,
      settleDocked: () => undefined,
    });
    expect(getTask(worker.id)!.status).toBe('completed');
    expect(getTask(origin.id)!.status).toBe('pending');

    // 发起方侧 submitted 镜像 → 'out' 行直写 submitted；'in' 行已终态不受影响
    handleTaskSubmittedMirror({ taskId: DELEGATION_ID, runNo: 1 });
    expect(getTask(origin.id)!.status).toBe('submitted');
    expect(getTask(worker.id)!.status).toBe('completed');
  });
});
