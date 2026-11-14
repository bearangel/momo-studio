// electron/tests/hub/worker-terminal-consume.test.ts
//
// 任务生命周期 v2 P2 S4 回归锁（spec 2026-11-13 §8.2/§8.6 worker 侧消费）：
// hub 定向 task.accepted { taskId, runNo } / task.rejected { taskId, runNo, reason }
// → handleTaskAccepted / handleTaskRejected（remote-intervene-bridge）→ 复用
// lifecycle 写路径收敛：
//   1) accepted：submitted 任务 → completed（accepted_at/completed_at）+ run
//      accepted + acceptance 请求行 answered（remote:origin）+ 里程碑 kind=accepted
//      （meta 记事件 runNo 对账）+ 停靠出清
//   2) rejected：submitted 任务 → run rejected（reject_reason）+ 任务回 assigned
//      （返工排队）+ acceptance 答复 reject(reason) + 里程碑含 reason
//   3) 幂等：终态后再收 accepted → 静默；任务不存在 / 外派镜像行 → 静默零写入
//   4) 非 delegation 任务（delegation_id null）→ delegation 反查天然落空，静默
//   5) 停靠出清（真实 delegation-runner harness，S2 停靠断言同款）：accepted
//      消费后 docked 项出清 + 账本 done 零上报 + 再派重建会话
//
// mock 边界（momo-test-rules #5）：事件入口 handler 直调（hub/index onEvent 仅薄
// 转发）/ delegation-runner 端口 fake；DB 真实（worker-intervene-bridge.test.ts
// 同款 AP_USER_DATA_DIR 临时库）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, updateTask, getTask } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { listByTask } from '../../src/main/storage/tasks/human-requests-repo';
import { startRun, submitRun } from '../../src/main/task/lifecycle-runs';
import {
  handleTaskAccepted,
  handleTaskRejected,
  type WorkerTerminalConsumePorts,
} from '../../src/main/hub/remote-intervene-bridge';
import {
  createDelegationRunner,
  type AssignedTaskEvent,
  type DelegationRunPorts,
  type TurnTerminal,
} from '../../src/main/hub/delegation-runner';
import { createHubDelegationSettingsStore } from '../../src/main/hub/delegation-settings';
import { createHubDelegationStore } from '../../src/main/hub/delegation-store';
import type { TaskReportPayload } from '../../src/main/hub/delegation-wire';

const SELF_NODE = 'node-self';
const DELEGATION_ID = 'dl-hub-1';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-worker-terminal-consume-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
  vi.restoreAllMocks();
});

/** 种 delegation-bound 任务（peer-draft 承接形：delegation_id 挂接 + routing 指向本机） */
function seedDelegatedTask(): string {
  const t = insertTask({
    workspaceId: 'ws1',
    title: '委派任务',
    creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1',
    status: 'assigned',
    executionSessionId: execSessionId,
    delegationId: DELEGATION_ID,
    routing: { mode: 'node', groupId: 'g-1', targetNodeId: SELF_NODE },
  });
  return t.id;
}

/** 种本地普通任务（delegation_id null——反查落空面） */
function seedLocalTask(): string {
  const t = insertTask({
    workspaceId: 'ws1',
    title: '本地任务',
    creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1',
    status: 'assigned',
    executionSessionId: execSessionId,
  });
  return t.id;
}

/** 种 submitted 态任务（startRun + submitRun 真实链——acceptance 请求行随建） */
async function seedSubmittedTask(seed: () => string = seedDelegatedTask): Promise<string> {
  const taskId = seed();
  startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
  await submitRun(taskId, { summary: '交付说明' });
  return taskId;
}

/** 消费端口（settleDocked spy——停靠出清调用面断言） */
function consumePorts(): { ports: WorkerTerminalConsumePorts; settleDocked: ReturnType<typeof vi.fn> } {
  const settleDocked = vi.fn();
  return {
    ports: {
      selfNodeId: () => SELF_NODE,
      settleDocked: (taskId: string, outcome: 'accepted' | 'rejected') => settleDocked(taskId, outcome),
    },
    settleDocked,
  };
}

/** delegation_milestone 行（body + 结构化 meta） */
function milestoneRows(): Array<{ body: string; task_id: string; context_json: string }> {
  return getDb()
    .prepare(
      `SELECT body, task_id, context_json FROM messages WHERE event_type = 'delegation_milestone'`,
    )
    .all() as Array<{ body: string; task_id: string; context_json: string }>;
}

/** 任务的活动历史 run 原始行（accepted/rejected 后 getActiveRun 落空，直查表） */
function runDbRow(taskId: string): { status: string; reject_reason: string | null; ended_at: number | null } {
  return getDb()
    .prepare(`SELECT status, reject_reason, ended_at FROM task_runs WHERE task_id = ?`)
    .get(taskId) as { status: string; reject_reason: string | null; ended_at: number | null };
}

/** 任务的 acceptance 请求行（submitRun 随建；answered 断言载体） */
function acceptanceRow(taskId: string): { status: string; answer_json: string | null; answered_by_node_id: string | null } {
  const row = listByTask(taskId).find((r) => r.kind === 'acceptance');
  if (row === undefined) throw new Error(`任务 ${taskId} 无 acceptance 请求行`);
  return {
    status: row.status,
    answer_json: row.answerJson,
    answered_by_node_id: row.answeredByNodeId,
  };
}

// ── 1) accepted：submitted → completed 全链 ──────────────────────────────────

describe('1) accepted：submitted 任务 → completed + acceptance answered + 里程碑 + 停靠出清', () => {
  it('completeAcceptance 复用路径全字段（任务/run/请求行/里程碑 meta runNo/settleDocked）', async () => {
    const taskId = await seedSubmittedTask();
    expect(getTask(taskId)!.status).toBe('submitted');
    const { ports, settleDocked } = consumePorts();

    // 事件载荷 runNo=3 ≠ 本地 run_no=1——消费不依赖对齐（本地 run 计数自治，meta 对账展示用）
    await handleTaskAccepted({ taskId: DELEGATION_ID, runNo: 3 }, ports);

    const t = getTask(taskId)!;
    expect(t.status).toBe('completed');
    expect(t.acceptedAt).not.toBeNull();
    expect(t.completedAt).not.toBeNull();
    expect(runDbRow(taskId).status).toBe('accepted');
    expect(runDbRow(taskId).ended_at).not.toBeNull();

    const acc = acceptanceRow(taskId);
    expect(acc.status).toBe('answered');
    expect(acc.answered_by_node_id).toBe('remote:origin');
    expect(JSON.parse(acc.answer_json!)).toEqual({ decision: 'accept' });

    expect(milestoneRows()).toHaveLength(1);
    const ms = milestoneRows()[0]!;
    expect(ms.task_id).toBe(taskId);
    expect(ms.body).toContain('验收通过');
    expect(JSON.parse(ms.context_json)).toEqual({ kind: 'accepted', runNo: 3 });

    expect(settleDocked).toHaveBeenCalledTimes(1);
    expect(settleDocked).toHaveBeenCalledWith(DELEGATION_ID, 'accepted');
  });

  it('载荷缺 runNo → 里程碑 meta 不带 runNo 键（容错拾取）', async () => {
    const taskId = await seedSubmittedTask();
    const { ports } = consumePorts();
    await handleTaskAccepted({ taskId: DELEGATION_ID }, ports);
    expect(JSON.parse(milestoneRows()[0]!.context_json)).toEqual({ kind: 'accepted' });
    expect(getTask(taskId)!.status).toBe('completed');
  });
});

// ── 2) rejected：submitted → run rejected + 任务 assigned 返工 ────────────────

describe('2) rejected：submitted 任务 → run rejected（reject_reason）+ 任务 assigned + 里程碑含 reason', () => {
  it('rejectTask 复用路径全字段（run/请求行/任务回 assigned/里程碑 reason+runNo）', async () => {
    const taskId = await seedSubmittedTask();
    const { ports, settleDocked } = consumePorts();
    const reason = '测试覆盖不足，请补充错误分支用例后重新提交';

    // 事件 runNo=2 是 hub 侧新 run 号（账本单源）——本地不建 run，仅 meta 对账记录
    await handleTaskRejected({ taskId: DELEGATION_ID, runNo: 2, reason }, ports);

    expect(getTask(taskId)!.status).toBe('assigned'); // 返工排队（executor 正常放行重跑）
    const run = runDbRow(taskId);
    expect(run.status).toBe('rejected');
    expect(run.reject_reason).toBe(reason);
    expect(run.ended_at).not.toBeNull();

    const acc = acceptanceRow(taskId);
    expect(acc.status).toBe('answered');
    expect(acc.answered_by_node_id).toBe('remote:origin');
    expect(JSON.parse(acc.answer_json!)).toEqual({ decision: 'reject', reason });

    expect(milestoneRows()).toHaveLength(1);
    const ms = milestoneRows()[0]!;
    expect(ms.body).toContain(reason); // 里程碑含 reason（返工上下文承载）
    expect(JSON.parse(ms.context_json)).toEqual({ kind: 'rejected', reason, runNo: 2 });

    expect(settleDocked).toHaveBeenCalledTimes(1);
    expect(settleDocked).toHaveBeenCalledWith(DELEGATION_ID, 'rejected');
  });
});

// ── 3) 幂等：终态 / 不存在 / 外派镜像行 → 静默 ────────────────────────────────

describe('3) 幂等静默面', () => {
  it('终态后再收 accepted → 静默（零重复里程碑/零重复出清）', async () => {
    const taskId = await seedSubmittedTask();
    const { ports, settleDocked } = consumePorts();
    await handleTaskAccepted({ taskId: DELEGATION_ID, runNo: 1 }, ports);
    expect(milestoneRows()).toHaveLength(1);

    await expect(handleTaskAccepted({ taskId: DELEGATION_ID, runNo: 1 }, ports)).resolves.toBeUndefined();

    expect(getTask(taskId)!.status).toBe('completed');
    expect(milestoneRows()).toHaveLength(1); // 零重复写入
    expect(settleDocked).toHaveBeenCalledTimes(1); // 零重复出清
  });

  it('终态后再收 rejected → 同款静默（首决保留）', async () => {
    const taskId = await seedSubmittedTask();
    const { ports, settleDocked } = consumePorts();
    await handleTaskAccepted({ taskId: DELEGATION_ID, runNo: 1 }, ports);

    await expect(
      handleTaskRejected({ taskId: DELEGATION_ID, runNo: 2, reason: '迟到的打回' }, ports),
    ).resolves.toBeUndefined();

    expect(getTask(taskId)!.status).toBe('completed'); // 首决保留，不回 assigned
    expect(milestoneRows()).toHaveLength(1);
    expect(settleDocked).toHaveBeenCalledTimes(1);
  });

  it('任务不存在（delegation 反查落空）→ 不抛、零写入、零出清', async () => {
    const { ports, settleDocked } = consumePorts();
    await expect(handleTaskAccepted({ taskId: 'dl-nope', runNo: 1 }, ports)).resolves.toBeUndefined();
    await expect(
      handleTaskRejected({ taskId: 'dl-nope', runNo: 2, reason: 'x' }, ports),
    ).resolves.toBeUndefined();
    expect(milestoneRows()).toHaveLength(0);
    expect(settleDocked).not.toHaveBeenCalled();
  });

  it('外派镜像行（delegation_role=out，共享 delegation_id）→ 不在 worker 侧消费', async () => {
    const mirror = insertTask({
      workspaceId: 'ws1',
      title: '外派镜像行',
      creatorUserId: '@owner:home',
      status: 'submitted',
      executionSessionId: execSessionId,
      delegationId: DELEGATION_ID,
    });
    // delegation_role 不在 insertTask 列集（生产由 dispatch-submit 回执 updateTask 补戳）——同款补戳
    updateTask(mirror.id, { delegationRole: 'out' });
    const { ports, settleDocked } = consumePorts();

    await handleTaskAccepted({ taskId: DELEGATION_ID, runNo: 1 }, ports);
    await handleTaskRejected({ taskId: DELEGATION_ID, runNo: 2, reason: 'x' }, ports);

    expect(getTask(mirror.id)!.status).toBe('submitted'); // 镜像行不动（leader 侧由 S5 RPC 回执驱动）
    expect(milestoneRows()).toHaveLength(0);
    expect(settleDocked).not.toHaveBeenCalled();
  });

  it('异形载荷（非对象 / taskId 缺席 / rejected 缺 reason）→ 静默不消费', async () => {
    const taskId = await seedSubmittedTask();
    const { ports, settleDocked } = consumePorts();

    await expect(handleTaskAccepted('不是对象', ports)).resolves.toBeUndefined();
    await expect(handleTaskAccepted({ runNo: 1 }, ports)).resolves.toBeUndefined();
    await expect(handleTaskRejected({ taskId: DELEGATION_ID, runNo: 2 }, ports)).resolves.toBeUndefined();
    await expect(
      handleTaskRejected({ taskId: DELEGATION_ID, runNo: 2, reason: '   ' }, ports),
    ).resolves.toBeUndefined();

    expect(getTask(taskId)!.status).toBe('submitted');
    expect(acceptanceRow(taskId).status).toBe('pending');
    expect(milestoneRows()).toHaveLength(0);
    expect(settleDocked).not.toHaveBeenCalled();
  });
});

// ── 4) 非 delegation 任务 → 静默零写入 ────────────────────────────────────────

describe('4) 非 delegation 任务（delegation_id null）→ 静默零写入', () => {
  it('本地 submitted 任务不受未知委派 id 的验收事件影响', async () => {
    const localTaskId = await seedSubmittedTask(seedLocalTask);
    const { ports, settleDocked } = consumePorts();

    await expect(handleTaskAccepted({ taskId: 'dl-unknown', runNo: 1 }, ports)).resolves.toBeUndefined();
    await expect(
      handleTaskRejected({ taskId: 'dl-unknown', runNo: 2, reason: 'x' }, ports),
    ).resolves.toBeUndefined();

    const t = getTask(localTaskId)!;
    expect(t.status).toBe('submitted'); // 本地验收链不受远端事件干扰
    expect(acceptanceRow(localTaskId).status).toBe('pending');
    expect(milestoneRows()).toHaveLength(0);
    expect(settleDocked).not.toHaveBeenCalled();
  });
});

// ── 5) 停靠出清（真实 delegation-runner harness——S2 停靠断言同款）────────────

describe('5) 停靠出清：accepted 消费后 docked 项出清 + 账本对齐 + 零上报', () => {
  function makeRunnerHarness(): {
    runner: ReturnType<typeof createDelegationRunner>;
    store: ReturnType<typeof createHubDelegationStore>;
    settings: ReturnType<typeof createHubDelegationSettingsStore>;
    reports: Array<{ taskId: string; payload: TaskReportPayload }>;
    createdSessions: number;
    fireTerminal: (sessionId: string, t: TurnTerminal) => void;
  } {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
    const settings = createHubDelegationSettingsStore(db);
    const store = createHubDelegationStore(db);
    const reports: Array<{ taskId: string; payload: TaskReportPayload }> = [];
    const watchers = new Map<string, (t: TurnTerminal) => void>();
    let createdSessions = 0;
    const ports: DelegationRunPorts = {
      settings: () => settings.read(),
      findWorkspaceByName: () => ({ id: 'ws1', name: 'Test' }),
      resolveAgentInstance: () => 'inst-1',
      resolveAgentInstanceByName: () => null,
      createDelegatedSession: () => {
        createdSessions += 1;
        return `sess-${createdSessions}`;
      },
      applyRunPolicy: () => undefined,
      sessionWaiting: () => null,
      injectSteer: () => undefined,
      startTurn: async () => undefined,
      stopSession: () => undefined,
      watchTurn: (sessionId, onTerminal) => {
        watchers.set(sessionId, onTerminal);
        return () => {
          watchers.delete(sessionId);
        };
      },
      sessionTail: () => null,
      report: async (taskId, payload) => {
        reports.push({ taskId, payload });
        return true;
      },
      listInterruptedDelegations: async () => [],
      resolveBindingWorkspace: () => null,
      insertDraftTaskRow: () => null,
      // 生产端口同款：delegation_id → 真实库 tasks 行反查（停靠判定数据源）
      findDraftRow: (delegationId) => {
        const row = getDb()
          .prepare('SELECT id, status, execution_session_id FROM tasks WHERE delegation_id = ?')
          .get(delegationId) as
          | { id: string; status: string; execution_session_id: string | null }
          | undefined;
        return row
          ? { id: row.id, status: row.status, executionSessionId: row.execution_session_id }
          : null;
      },
      selfNodeId: () => SELF_NODE,
      // P2 v2 接线端口桩（真实接线面在 worker-runner-v2-wiring.test 锁）
      linkExecutionSession: () => undefined,
      startLifecycleRun: () => undefined,
      pendingHumanRequests: () => 0,
    };
    const runner = createDelegationRunner({ ports, store, tickMs: 500 });
    return {
      runner,
      store,
      settings,
      reports,
      get createdSessions() {
        return createdSessions;
      },
      fireTerminal: (sessionId, t) => {
        watchers.get(sessionId)?.(t);
      },
    };
  }

  function assignedEvt(taskId: string): AssignedTaskEvent {
    return {
      taskId,
      workspaceName: 'Test',
      task: { title: '委派任务', prompt: '请完成委派工作并提交。' },
      byNode: 'node-leader',
    };
  }

  it('docked 非空时 accepted 消费 → 出清 + 账本 done 零上报 + 并发槽释放', async () => {
    const h = makeRunnerHarness();
    h.settings.write({ acceptTasks: true, maxConcurrent: 1, hitlTimeoutMinutes: 15 });
    const taskId = await seedSubmittedTask(); // 真实库：任务 submitted
    await h.runner.handleAssigned(assignedEvt(DELEGATION_ID));

    // 回合终态 → 停靠（S2 语义：不上报 done/failed、账本保持 running）
    h.fireTerminal('sess-1', { status: 'done' });
    expect(h.reports.find((r) => r.taskId === DELEGATION_ID && r.payload.status === 'done')).toBeUndefined();
    expect(h.store.get(DELEGATION_ID)!.state).toBe('running');
    // 停靠项占用并发槽（active.size 计数）——maxConcurrent=1 下新委派被拒
    await h.runner.handleAssigned(assignedEvt('dl-other'));
    expect(h.reports.find((r) => r.taskId === 'dl-other')?.payload.reason).toMatch(/^declined:/);

    await handleTaskAccepted(
      { taskId: DELEGATION_ID, runNo: 1 },
      {
        selfNodeId: () => SELF_NODE,
        settleDocked: (id, outcome) => {
          h.runner.settleAcceptance(id, outcome);
        },
      },
    );

    // 停靠出清 + 账本对齐 done（hub 已终局——零 done 上报，不双发）
    expect(h.store.get(DELEGATION_ID)!.state).toBe('done');
    expect(h.reports.find((r) => r.taskId === DELEGATION_ID && r.payload.status === 'done')).toBeUndefined();
    expect(getTask(taskId)!.status).toBe('completed');

    // 出清后并发槽释放（active 不再占用）——新委派可接受重建会话
    await h.runner.handleAssigned(assignedEvt('dl-other'));
    expect(h.reports.find((r) => r.taskId === 'dl-other' && r.payload.status === 'running')).toBeDefined();
    expect(h.createdSessions).toBe(2);

    h.runner.destroy();
  });

  it('rejected 消费 → 出清但账本保持 running（返工由本地 executor 放行续跑）', async () => {
    const h = makeRunnerHarness();
    h.settings.write({ acceptTasks: true, maxConcurrent: 1, hitlTimeoutMinutes: 15 });
    await seedSubmittedTask();
    await h.runner.handleAssigned(assignedEvt(DELEGATION_ID));
    h.fireTerminal('sess-1', { status: 'done' });

    await handleTaskRejected(
      { taskId: DELEGATION_ID, runNo: 2, reason: '请返工' },
      {
        selfNodeId: () => SELF_NODE,
        settleDocked: (id, outcome) => {
          h.runner.settleAcceptance(id, outcome);
        },
      },
    );

    expect(h.store.get(DELEGATION_ID)!.state).toBe('running'); // 非终态：监督器/进度拍链照常接管返工
    expect(h.reports.find((r) => r.taskId === DELEGATION_ID && r.payload.status === 'done')).toBeUndefined();

    // 出清后并发槽释放——新委派可接受（rejected 侧返工不走 hub 再派，槽位仍须让出）
    await h.runner.handleAssigned(assignedEvt('dl-other'));
    expect(h.reports.find((r) => r.taskId === 'dl-other' && r.payload.status === 'running')).toBeDefined();
    expect(h.createdSessions).toBe(2);

    h.runner.destroy();
  });

  it('无停靠项（未接管/重启丢失）→ 幂等 no-op，accepted 侧账本仍对齐 done', async () => {
    const h = makeRunnerHarness();
    await seedSubmittedTask(); // 无 handleAssigned：active 无此项（重启窗口形态）
    const now = Date.now();
    h.store.upsert({
      taskId: DELEGATION_ID,
      sessionId: 'sess-stale',
      workspaceId: 'ws1',
      workspaceName: 'Test',
      title: '委派任务',
      byNode: 'node-leader',
      state: 'running',
      createdAt: now,
      updatedAt: now,
    });

    expect(() => h.runner.settleAcceptance(DELEGATION_ID, 'accepted')).not.toThrow();
    // 迟到消费仍终结账本（防监督器后续 duplicate 终态直报）
    expect(h.store.get(DELEGATION_ID)!.state).toBe('done');

    h.runner.destroy();
  });
});
