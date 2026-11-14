// electron/tests/hub/worker-intervene-bridge.test.ts
//
// 任务生命周期 v2 P2 S2 回归锁（spec 2026-11-13 §8.6 worker 侧桥）：
// worker 节点上 delegation-bound 本地任务（delegation_id 非空 + 本机执行方）的
// lifecycle 事件（request_human / tool_gate 落行 / submitRun 提交）经
// remote-intervene sink 桥到 hub：
//   - request_created → task.intervene（载荷逐字段：interventionId/runNo/kind/
//     title/prompt/payload/options/deadlineAt；RPC 失败降级本地等待不抛）
//   - run_submitted → task.report {status:'submitted', runNo, reason=deliverable JSON}
//     （版本门 minor≥11；失败/旧 hub 降级 P1 旧行为：本地验收兜底收口 completed）
//   - 幂等：同 (taskId, runNo) 的重复 run_submitted 零重复 report（重放防护）
//
// mock 边界（momo-test-rules #5）：hub client（ws RPC/sendRes）mock；DB 真实
// （lifecycle-event-forwarding.test.ts 同款 AP_USER_DATA_DIR 临时库）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, type TaskRow } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { getActiveRun } from '../../src/main/storage/tasks/runs-repo';
import {
  insertHumanRequest,
  getHumanRequest,
} from '../../src/main/storage/tasks/human-requests-repo';import {
  setRemoteInterveneSink,
  requestHuman,
  startRun,
  submitRun,
  acceptTask,
} from '../../src/main/task/lifecycle-runs';
import { TASK_RPC } from '../../src/main/hub/protocol';
import { TASK_WIRE } from '../../src/main/hub/delegation-wire';
import { RpcRemoteError, type HubClient } from '../../src/main/hub/client';
import {
  createRemoteInterveneHandler,
  type RemoteInterveneBridgePorts,
  type RemoteInterveneEventInput,
} from '../../src/main/hub/remote-intervene-bridge';

const SELF_NODE = 'node-self';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-worker-intervene-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

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
  setRemoteInterveneSink(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
  vi.restoreAllMocks();
});

/** fake hub client（mock 边界唯一面）：request / sendRes / state / hubProtoVer */
function mkFakeClient(opts?: {
  protoVer?: string;
  online?: boolean;
  requestImpl?: (method: string, payload: unknown) => Promise<unknown>;
  sendResOk?: boolean;
}): HubClient {
  return {
    start: () => undefined,
    stop: () => undefined,
    state: () => (opts?.online === false ? ('disconnected' as const) : ('online' as const)),
    hubProtoVer: () => opts?.protoVer ?? '1.11.0',
    request: vi.fn(
      opts?.requestImpl ??
        (async () => ({ interventionId: 'x' })),
    ) as unknown as HubClient['request'],
    sendRes: vi.fn(
      ((_id: string, _method: string, _payload: unknown) => opts?.sendResOk ?? true) as HubClient['sendRes'],
    ),
  } as HubClient;
}

/** handler 工厂：DB 面全真（getTask/getActiveRun/acceptTask 直连真实库），
 *  仅 hub client 与节点身份注入。acceptTask 包记录供降级路径断言。 */
function mkBridge(client: HubClient, opts?: { selfNodeId?: string | null }): {
  handler: (e: RemoteInterveneEventInput) => void;
  acceptCalls: string[];
} {
  const acceptCalls: string[] = [];
  const ports: RemoteInterveneBridgePorts = {
    clientGetter: () => client,
    selfNodeId: () => (opts?.selfNodeId === undefined ? SELF_NODE : opts.selfNodeId),
    getTask: (id) => getTask(id),
    getActiveRun: (id) => getActiveRun(id),
    findActiveTaskByExecutionSession: (sessionId) =>
      (getDb()
        .prepare(
          'SELECT id FROM tasks WHERE execution_session_id = ? ORDER BY created_at DESC LIMIT 5',
        )
        .all(sessionId) as Array<{ id: string }>)
        .map((r) => getTask(r.id))
        .filter(
          (t): t is TaskRow =>
            t !== null && !['completed', 'failed', 'cancelled'].includes(t.status),
        )[0] ?? null,
    acceptTask: async (id) => {
      acceptCalls.push(id);
      await acceptTask(id);
    },
  };
  return { handler: createRemoteInterveneHandler(ports), acceptCalls };
}

/** wireBridge：注册进 lifecycle-runs sink（生产装配同形——submitRun/requestHuman 直接触发） */
function wireBridge(client: HubClient, opts?: { selfNodeId?: string | null }): {
  handler: (e: RemoteInterveneEventInput) => void;
  acceptCalls: string[];
} {
  const bridge = mkBridge(client, opts);
  setRemoteInterveneSink(bridge.handler);
  return bridge;
}

/** 种 delegation-bound 任务（peer-draft 承接形：delegation_id 挂接 + routing 指向本机） */
function seedDelegatedTask(delegationId: string | null): string {
  const t = insertTask({
    workspaceId: 'ws1',
    title: '委派任务',
    creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1',
    status: 'assigned',
    executionSessionId: execSessionId,
    ...(delegationId !== null
      ? {
          delegationId,
          routing: { mode: 'node' as const, groupId: 'g-1', targetNodeId: SELF_NODE },
        }
      : {}),
  });
  return t.id;
}

/** 等待 fire-and-forget 的 RPC promise 链收敛（intervene 是 void promise） */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ── 1) request_created → task.intervene ─────────────────────────────────────

describe('request_created → task.intervene', () => {
  it('delegation-bound 任务（question 带选项/载荷/期限）→ 载荷逐字段精确', async () => {
    const client = mkFakeClient();
    wireBridge(client);

    const taskId = seedDelegatedTask('dl-1');
    const run = startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    const row = requestHuman({
      sessionId: execSessionId,
      kind: 'question',
      title: '需要确认',
      prompt: '选 A 还是 B',
      taskId,
      runId: run.id,
      optionsJson: JSON.stringify([
        { id: 'a', label: '方案A' },
        { id: 'b', label: '方案B', description: '保守' },
      ]),
      payloadJson: JSON.stringify({ context: { stage: 2 } }),
      deadlineMinutes: 30,
    });
    await flushAsync();

    expect(client.request).toHaveBeenCalledTimes(1);
    const [method, payload] = vi.mocked(client.request).mock.calls[0] as [string, unknown];
    expect(method).toBe(TASK_RPC.intervene);
    expect(payload).toEqual({
      taskId: 'dl-1',
      intervention: {
        interventionId: row.id,
        runNo: 1,
        kind: 'question',
        title: '需要确认',
        prompt: '选 A 还是 B',
        payload: { context: { stage: 2 } },
        options: [
          { id: 'a', label: '方案A' },
          { id: 'b', label: '方案B', description: '保守' },
        ],
        deadlineAt: row.deadlineAt,
      },
    });
  });

  it('tool_gate 行（taskId 空，按执行会话定位 delegation-bound 任务）→ kind/payload 映射', async () => {
    const client = mkFakeClient();
    const { handler } = mkBridge(client);

    const taskId = seedDelegatedTask('dl-2');
    startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    const row = insertHumanRequest({
      sessionId: execSessionId,
      kind: 'tool_gate',
      title: '写授权：npm run build',
      prompt: 'bash 命令需要写入以下目录，请审批：',
      payloadJson: JSON.stringify({
        toolGate: { toolName: 'bash', command: 'npm run build', dirs: ['/tmp/w'] },
      }),
      deadlineAt: Date.now() + 15 * 60_000,
      timeoutPolicy: 'deny_and_wrap',
    });
    // write-blocked-emit 生产装配（setToolGateRowSink）触发面在此以同形事件直发
    handler({ kind: 'request_created', request: row });
    await flushAsync();

    expect(client.request).toHaveBeenCalledTimes(1);
    const [, payload] = vi.mocked(client.request).mock.calls[0] as [string, unknown];
    expect(payload).toEqual({
      taskId: 'dl-2',
      intervention: {
        interventionId: row.id,
        runNo: 1,
        kind: 'tool_gate',
        title: '写授权：npm run build',
        prompt: 'bash 命令需要写入以下目录，请审批：',
        payload: { toolGate: { toolName: 'bash', command: 'npm run build', dirs: ['/tmp/w'] } },
        deadlineAt: row.deadlineAt,
      },
    });
  });

  it('本地任务（delegation_id null）→ 零 RPC', async () => {
    const client = mkFakeClient();
    wireBridge(client);

    const taskId = seedDelegatedTask(null);
    const run = startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    requestHuman({
      sessionId: execSessionId,
      kind: 'manual_action',
      title: '请重启服务',
      prompt: '重启后点完成',
      taskId,
      runId: run.id,
    });
    await flushAsync();

    expect(client.request).not.toHaveBeenCalled();
    expect(client.sendRes).not.toHaveBeenCalled();
  });

  it('外派镜像行（routing 指向远端）→ 零 RPC（只桥本机执行方）', async () => {
    const client = mkFakeClient();
    wireBridge(client);

    const t = insertTask({
      workspaceId: 'ws1',
      title: '外派行',
      creatorUserId: '@owner:home',
      status: 'assigned',
      executionSessionId: execSessionId,
      delegationId: 'dl-3',
      routing: { mode: 'node', groupId: 'g-1', targetNodeId: 'node-other' },
    });
    const run = startRun(t.id, { trigger: 'initial', executionSessionId: execSessionId });
    requestHuman({
      sessionId: execSessionId,
      kind: 'question',
      title: 'q',
      prompt: 'p',
      taskId: t.id,
      runId: run.id,
    });
    await flushAsync();
    expect(client.request).not.toHaveBeenCalled();
  });

  it('intervene 失败（unsupported_method）→ 不抛、请求行保留 pending（本地等待降级）', async () => {
    const client = mkFakeClient({
      requestImpl: async () => {
        throw new RpcRemoteError('unsupported_method', '节点不支持的方法: task.intervene');
      },
    });
    wireBridge(client);

    const taskId = seedDelegatedTask('dl-4');
    const run = startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    const row = requestHuman({
      sessionId: execSessionId,
      kind: 'question',
      title: '需要确认',
      prompt: '选 A',
      taskId,
      runId: run.id,
    });
    await flushAsync();

    expect(getHumanRequest(row.id)?.status).toBe('pending'); // 降级：本地等待照旧
    expect(getTask(taskId)?.status).toBe('waiting_human'); // 等人体不被降级破坏
  });
});

// ── 3) 降级里程碑持久记录（评审轮 1：delegation_milestone 系统消息） ─────────

interface MilestoneRow {
  sender: string;
  event_type: string;
  body: string;
  task_id: string | null;
  context_json: string | null;
}

function milestoneRows(): MilestoneRow[] {
  return getDb()
    .prepare(
      "SELECT sender, event_type, body, task_id, context_json FROM messages WHERE event_type = 'delegation_milestone'",
    )
    .all() as MilestoneRow[];
}

describe('降级里程碑（Review Focus #1——降级原因落执行会话）', () => {
  it('intervene 降级（unsupported_method）→ 会话出现 delegation_milestone 行（meta kind/reason/code）', async () => {
    const client = mkFakeClient({
      requestImpl: async () => {
        throw new RpcRemoteError('unsupported_method', '节点不支持的方法: task.intervene');
      },
    });
    wireBridge(client);

    const taskId = seedDelegatedTask('dl-10');
    const run = startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    requestHuman({
      sessionId: execSessionId,
      kind: 'question',
      title: '需要确认',
      prompt: '选 A',
      taskId,
      runId: run.id,
    });
    await flushAsync();

    const rows = milestoneRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sender).toBe('system');
    expect(rows[0]!.event_type).toBe('delegation_milestone');
    expect(rows[0]!.task_id).toBe(taskId);
    expect(rows[0]!.body).toContain('干预上报降级');
    expect(rows[0]!.body).toContain('已转本地等待，节点所有者可在请求面板处理');
    expect(JSON.parse(rows[0]!.context_json!)).toEqual({
      kind: 'intervene_degraded',
      reason: 'task.intervene 失败：节点不支持的方法: task.intervene',
      code: 'unsupported_method',
    });
  });

  it('report 降级（sendRes false）→ 同款 delegation_milestone 行（meta kind=submit_degraded/reason）', async () => {
    const client = mkFakeClient({ sendResOk: false });
    wireBridge(client);

    const taskId = seedDelegatedTask('dl-11');
    startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    await submitRun(taskId, { summary: '交付' });
    await flushAsync();

    const rows = milestoneRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sender).toBe('system');
    expect(rows[0]!.task_id).toBe(taskId);
    expect(rows[0]!.body).toContain('提交上报降级');
    expect(rows[0]!.body).toContain('任务按旧语义完成');
    expect(JSON.parse(rows[0]!.context_json!)).toEqual({
      kind: 'submit_degraded',
      reason: 'sendRes 失败（连接半关）',
    });
  });

  it('任务无执行会话（execution_session_id 空）→ 降级零写入不抛（logger 兜底）', async () => {
    const client = mkFakeClient({ online: false });
    const { handler } = mkBridge(client);

    const t = insertTask({
      workspaceId: 'ws1',
      title: '无会话委派任务',
      creatorUserId: '@owner:home',
      status: 'assigned',
      delegationId: 'dl-12',
      routing: { mode: 'node', groupId: 'g-1', targetNodeId: SELF_NODE },
    });
    startRun(t.id, { trigger: 'initial' });
    getDb().prepare("UPDATE tasks SET status = 'submitted' WHERE id = ?").run(t.id);

    expect(() =>
      handler({ kind: 'run_submitted', taskId: t.id, runNo: 1, deliverable: { summary: '交付' } }),
    ).not.toThrow();
    await flushAsync();
    expect(milestoneRows()).toHaveLength(0);
  });
});

// ── 2) run_submitted → task.report submitted ────────────────────────────────

describe('run_submitted → task.report submitted', () => {
  it('提交 → report 载荷精确（status/runNo/reason=deliverable JSON）', async () => {
    const client = mkFakeClient();
    wireBridge(client);

    const taskId = seedDelegatedTask('dl-5');
    startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    await submitRun(taskId, {
      summary: '交付完成',
      files: ['a.ts'],
      artifacts: [{ label: '测试', value: '通过' }],
    });
    await flushAsync();

    expect(client.sendRes).toHaveBeenCalledTimes(1);
    const [id, method, payload] = vi.mocked(client.sendRes).mock.calls[0] as [
      string,
      string,
      unknown,
    ];
    expect(id).toBe('dl-5');
    expect(method).toBe(TASK_WIRE.report);
    expect(payload).toEqual({
      status: 'submitted',
      runNo: 1,
      reason: JSON.stringify({
        summary: '交付完成',
        files: ['a.ts'],
        artifacts: [{ label: '测试', value: '通过' }],
      }),
    });
  });

  it('本地任务（delegation_id null）提交 → 零 report', async () => {
    const client = mkFakeClient();
    wireBridge(client);

    const taskId = seedDelegatedTask(null);
    startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    await submitRun(taskId, { summary: '本地交付' });
    await flushAsync();

    expect(client.sendRes).not.toHaveBeenCalled();
  });

  it('report 失败（sendRes false）→ 降级：本地验收兜底（acceptTask）收口 completed', async () => {
    const client = mkFakeClient({ sendResOk: false });
    const { acceptCalls } = wireBridge(client);

    const taskId = seedDelegatedTask('dl-6');
    startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    await submitRun(taskId, { summary: '交付' });
    await flushAsync();

    expect(acceptCalls).toEqual([taskId]); // P1 旧行为：单方完成
    expect(getTask(taskId)?.status).toBe('completed');
  });

  it('旧 hub（protoVer 1.10.0）在线 → 版本门拦截：零 report + 同款降级收口', async () => {
    const client = mkFakeClient({ protoVer: '1.10.0' });
    const { acceptCalls } = wireBridge(client);

    const taskId = seedDelegatedTask('dl-7');
    startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    await submitRun(taskId, { summary: '交付' });
    await flushAsync();

    expect(client.sendRes).not.toHaveBeenCalled(); // 不发半套语义的 submitted
    expect(acceptCalls).toEqual([taskId]);
    expect(getTask(taskId)?.status).toBe('completed');
  });

  it('幂等：同 (taskId, runNo) 重复 run_submitted → 零重复 report', async () => {
    const client = mkFakeClient();
    const { handler } = wireBridge(client);

    const taskId = seedDelegatedTask('dl-8');
    startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    await submitRun(taskId, { summary: '交付' });
    await flushAsync();
    expect(client.sendRes).toHaveBeenCalledTimes(1);

    // 重放同形事件（重连风暴/消息重投递形态——同一 handler 幂等拦截，
    // 生产装配面 ensureRemoteInterveneBridge 恒为单 handler 实例）
    handler({ kind: 'run_submitted', taskId, runNo: 1, deliverable: { summary: '交付' } });
    await flushAsync();
    expect(client.sendRes).toHaveBeenCalledTimes(1); // 不变
  });

  it('超长 deliverable → reason 截断至 ≤512（hub REASON_MAX 整包拒防线）', async () => {
    const client = mkFakeClient();
    wireBridge(client);

    const taskId = seedDelegatedTask('dl-9');
    startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    await submitRun(taskId, { summary: '长'.repeat(800) });
    await flushAsync();

    expect(client.sendRes).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(client.sendRes).mock.calls[0]![2] as { reason: string };
    expect(payload.reason.length).toBeLessThanOrEqual(512);
    expect(payload.reason).toBe(JSON.stringify({ summary: '长'.repeat(400) + '…' }));
  });
});
