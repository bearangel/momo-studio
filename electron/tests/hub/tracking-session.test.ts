// electron/tests/hub/tracking-session.test.ts
//
// 任务生命周期 v2 P2 S6 回归锁（spec 2026-11-13 §8.5 发起方跟踪面）：
//   1) ensureTrackingSession：sessions 行 kind='task_execution' / 标题
//      `#T-<id> · → <节点名>` / 无成员 / execution_session_id 指向
//   2) 幂等：已有指向即复用（不重建不改题）；retryDispatch 不重建
//   3) 标题降级：组清单不可达 / 节点名缺席 → 「远端节点」
//   4) backfillTrackingSessions：无会话 active 外派行补建；已有会话 /
//      终态 / 非 out / 未派发行跳过
//   5) 服务端只读闸（终审 Finding #4 清偿）：sendUserMessage 对 out 任务执行
//      会话拒绝人话；任务完结解锁；本地执行会话不受影响
//   6) retryDispatch 成功路径经端口补建（首派失败留待处理的行）
//
// mock 边界（momo-test-rules #5）：网络面（组清单）注入 fake；DB 真实
// （origin-submitted-mirror.test.ts 同款 AP_USER_DATA_DIR 临时库）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, updateTask, type TaskRow } from '../../src/main/storage/tasks/repo';
import { getSession, insertSession } from '../../src/main/storage/sessions/repo';
import { retryDispatch } from '../../src/main/hub/delegation-sync';
import {
  ensureTrackingSession,
  backfillTrackingSessions,
  trackingSessionTitle,
  type TrackingSessionPorts,
} from '../../src/main/hub/tracking-session';
import { sendUserMessage } from '../../src/main/im/session-service';

const WORKER_NODE = 'node-worker';
const DELEGATION_ID = 'dl-s6-1';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-tracking-session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 组清单 fake：命中 WORKER_NODE → 研发工作站；可注入拒绝形态 */
function makePorts(opts?: { groupsError?: boolean }): TrackingSessionPorts {
  return {
    listGroups: async () => {
      if (opts?.groupsError) throw new Error('hub 不可达');
      return [{ members: [{ nodeId: WORKER_NODE, name: '研发工作站' }] }];
    },
  };
}

/** 种外派行（delegation_role='out' + node 路由缺省指向 WORKER_NODE） */
function seedOutTask(opts?: {
  sessionId?: string | null;
  role?: 'out' | 'in' | null;
  status?: TaskRow['status'];
  delegationId?: string | null;
  routing?: TaskRow['routing'];
}): TaskRow {
  const t = insertTask({
    workspaceId: 'ws1',
    title: '外派任务',
    creatorUserId: '@owner:home',
    status: opts?.status ?? 'pending',
    ...(opts?.sessionId !== undefined ? { executionSessionId: opts.sessionId } : {}),
    delegationId: opts?.delegationId === undefined ? DELEGATION_ID : opts.delegationId,
    routing: opts?.routing ?? { mode: 'node', groupId: 'g-1', targetNodeId: WORKER_NODE },
  });
  const role = opts?.role === undefined ? 'out' : opts.role;
  if (role !== null) updateTask(t.id, { delegationRole: role });
  return getTask(t.id)!;
}

// ── 1) 创建：行形状逐字段 ──────────────────────────────────────────────────

describe('1) ensureTrackingSession 创建', () => {
  it('kind=task_execution / 标题含节点名 / 无成员 / execution_session_id 指向', async () => {
    const task = seedOutTask();
    const sid = await ensureTrackingSession({ taskId: task.id, targetNodeId: WORKER_NODE }, makePorts());

    expect(sid).not.toBeNull();
    const session = getSession(sid!)!;
    expect(session).not.toBeNull();
    expect(session.kind).toBe('task_execution');
    expect(session.title).toBe(`#${task.id} · → 研发工作站`);
    expect(getDb().prepare('SELECT * FROM session_members WHERE session_id = ?').all(sid!)).toHaveLength(0);
    expect(getTask(task.id)!.executionSessionId).toBe(sid);
  });

  it('标题函数单源：节点名缺席 → 远端节点', () => {
    expect(trackingSessionTitle('T-007', '研发工作站')).toBe('#T-007 · → 研发工作站');
    expect(trackingSessionTitle('T-007', null)).toBe('#T-007 · → 远端节点');
  });
});

// ── 2) 幂等 ─────────────────────────────────────────────────────────────────

describe('2) 幂等：已有指向即复用', () => {
  it('二次调用返回同一 id，不新建会话不改题', async () => {
    const task = seedOutTask();
    const first = await ensureTrackingSession({ taskId: task.id, targetNodeId: WORKER_NODE }, makePorts());
    const second = await ensureTrackingSession({ taskId: task.id, targetNodeId: 'node-other' }, makePorts());

    expect(second).toBe(first);
    const count = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE kind = 'task_execution'`)
      .get() as { n: number };
    expect(count.n).toBe(1);
    expect(getSession(first!)!.title).toBe(`#${task.id} · → 研发工作站`);
  });

  it('非 out / 不存在的任务 → null 零副作用', async () => {
    const inTask = seedOutTask({ role: 'in' });
    expect(await ensureTrackingSession({ taskId: inTask.id, targetNodeId: WORKER_NODE }, makePorts())).toBeNull();
    expect(await ensureTrackingSession({ taskId: 'T-404', targetNodeId: WORKER_NODE }, makePorts())).toBeNull();
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM sessions`).get()).toEqual({ n: 0 });
  });
});

// ── 3) 标题降级 ─────────────────────────────────────────────────────────────

describe('3) 标题降级', () => {
  it('组清单不可达 / 节点名缺席 → 「远端节点」', async () => {
    const t1 = seedOutTask();
    await ensureTrackingSession({ taskId: t1.id, targetNodeId: WORKER_NODE }, makePorts({ groupsError: true }));
    expect(getSession(getTask(t1.id)!.executionSessionId!)!.title).toBe(`#${t1.id} · → 远端节点`);

    const t2 = seedOutTask();
    await ensureTrackingSession({ taskId: t2.id, targetNodeId: null }, makePorts());
    expect(getSession(getTask(t2.id)!.executionSessionId!)!.title).toBe(`#${t2.id} · → 远端节点`);
  });
});

// ── 4) 装配对账回填 ─────────────────────────────────────────────────────────

describe('4) backfillTrackingSessions', () => {
  it('无会话 active 外派行补建；已有会话 / 终态 / 非 out / 未派发行跳过', async () => {
    const backfillTarget = seedOutTask(); // 候选：out + 已派发 + 无会话
    const withSession = seedOutTask(); // 已有指向 → 跳过
    const sid = await ensureTrackingSession({ taskId: withSession.id, targetNodeId: WORKER_NODE }, makePorts());
    seedOutTask({ status: 'completed' }); // 终态 → 跳过
    seedOutTask({ role: 'in' }); // 承接行 → 跳过
    seedOutTask({ delegationId: null }); // 未派发（首派失败留待处理）→ 跳过

    const n = await backfillTrackingSessions(makePorts());

    expect(n).toBe(1);
    const created = getTask(backfillTarget.id)!.executionSessionId;
    expect(created).not.toBeNull();
    expect(created).not.toBe(sid);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM sessions WHERE kind = 'task_execution'`).get()).toEqual({
      n: 2,
    });
  });
});

// ── 5) 服务端只读闸（终审 Finding #4 清偿）─────────────────────────────────

describe('5) 只读跟踪会话服务端闸（sendUserMessage）', () => {
  it('out 任务执行会话拒绝人话；消息零落库', async () => {
    insertSession({ workspaceId: 'ws1', title: '跟踪', kind: 'task_execution' });
    const sid = getDb().prepare(`SELECT id FROM sessions`).get() as { id: string };
    seedOutTask({ sessionId: sid.id });

    await expect(sendUserMessage({ sessionId: sid.id, body: '直接发消息' })).rejects.toThrow(
      '只读跟踪会话：操作经请求面板进行',
    );
    expect(
      getDb().prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`).get(sid.id),
    ).toEqual({ n: 0 });
  });

  it('任务完结 → 闸解除（与 SessionSummary readOnly 派生同源）；本地执行会话（非委派）不受影响', async () => {
    const done = insertSession({ workspaceId: 'ws1', title: '跟踪', kind: 'task_execution' });
    const task = seedOutTask({ sessionId: done.id, status: 'submitted' });
    updateTask(task.id, { status: 'completed', completedAt: Date.now() });

    const local = insertSession({ workspaceId: 'ws1', title: '本地', kind: 'chat' });
    seedOutTask({ sessionId: local.id, role: null, delegationId: null });

    // 两会话均无成员（members 空 → readOnly=true 是既有「全失效」语义，与跟踪闸
    // 无关）；此处锁「闸放行」——不抛错且消息落库
    await expect(sendUserMessage({ sessionId: done.id, body: '任务完成后可发言' })).resolves.toEqual({
      readOnly: true,
    });
    await expect(sendUserMessage({ sessionId: local.id, body: '普通会话照常' })).resolves.toEqual({
      readOnly: true,
    });
    expect(
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id IN (?, ?)`)
        .get(done.id, local.id),
    ).toEqual({ n: 2 });
  });
});

// ── 6) retryDispatch 成功路径补建 ───────────────────────────────────────────

describe('6) retryDispatch × ensureTrackingSession 端口', () => {
  it('重派成功 → 端口补建跟踪会话（首派失败行此前无会话）；再次重派复用不重建', async () => {
    // 首派失败形态：pending + delegation_id 空（失败重派前先置 failed）
    const task = seedOutTask({ delegationId: null, status: 'failed' });
    const ensureSpy = vi.fn(async (input: { taskId: string; targetNodeId: string | null }) =>
      ensureTrackingSession(input, makePorts()),
    );

    const dispatch = async (): Promise<void> => {
      await retryDispatch(task.id, {
        getTask: (id) => getTask(id),
        workspaceNameOf: () => 'Test',
        resolveTarget: async () => WORKER_NODE,
        getTeamSnapshot: () => null,
        delegate: async () => ({ taskId: `dl-retry-${Date.now()}` }),
        ensureTrackingSession: ensureSpy,
        updateTask: (id, patch) => updateTask(id, patch),
        now: () => Date.now(),
      });
    };
    await dispatch();

    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expect(ensureSpy).toHaveBeenCalledWith({ taskId: task.id, targetNodeId: WORKER_NODE });
    const sid = getTask(task.id)!.executionSessionId;
    expect(sid).not.toBeNull();
    expect(getTask(task.id)!.delegationRole).toBe('out');

    // 幂等锁：同任务再次触发（如重派后事件重放形态）→ 复用既有会话不重建
    updateTask(task.id, { status: 'failed', errorMessage: null, delegationId: null });
    await dispatch();
    expect(getTask(task.id)!.executionSessionId).toBe(sid);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM sessions WHERE kind = 'task_execution'`).get()).toEqual({
      n: 1,
    });
  });
});
