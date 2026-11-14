// electron/tests/hub/worker-runner-v2-wiring.test.ts
//
// 任务生命周期 v2 P2：worker 委派执行链接线回归锁（2026-11-14 双实例 E2E
// 生产事故——B 库 T-001 无 run / 无会话绑定 / 直通 completed 而 question 行
// pending，hub delegation_interventions 空）。锁四件事：
//   1) handleAssigned 接线：承接行 execution_session_id 回写 + task_runs 落行
//      （runNo 1 / trigger initial）——降级象限同样无条件接线
//   2) request_human 按执行会话反查任务命中（请求带 task_id + run_id、任务
//      waiting_human）——S2 桥 task.intervene 上行的前置锚点
//   3) settleRun done 守卫：等待人工的回合不结算不报（awaitingHuman + watcher
//      复挂）；请求被答后下一终态正常结算报 done
//   4) submit_task 停靠：submitRun 后回合终态停靠待验收（S2 既有语义在 v2
//      接线下的回归）；waiting 映射四象限（twoPhase → waiting_human、
//      降级 → in_progress）
//
// mock 边界（momo-test-rules #5）：会话执行/上报/watchTurn 为 fake 端口；
// v2 接线三端口 = 生产产品函数直连真实库（delegation-ports 导出）；承接行
// 建链 = wrapWorkerStore 真装饰（worker-terminal-consume.test 同款 AP_USER_DATA_DIR
// 临时库）。watchTurn fake 仿真生产单次订阅语义（fire 即消费，复挂才再有回调）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, updateTask, getTask } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { getActiveRun } from '../../src/main/storage/tasks/runs-repo';
import { listByTask } from '../../src/main/storage/tasks/human-requests-repo';
import { answerHuman, submitRun } from '../../src/main/task/lifecycle-runs';
import { requestHumanFromAgent } from '../../src/main/agent/tools/task-tools';
import {
  createDelegationRunner,
  type AssignedTaskEvent,
  type DelegationRunPorts,
  type TurnTerminal,
} from '../../src/main/hub/delegation-runner';
import {
  linkExecutionSessionProduct,
  pendingHumanRequestsProduct,
  startLifecycleRunProduct,
} from '../../src/main/hub/delegation-ports';
import {
  createDelegationSync,
  mapHubStatus,
  type DelegationSyncPorts,
} from '../../src/main/hub/delegation-sync';
import { createHubDelegationSettingsStore } from '../../src/main/hub/delegation-settings';
import { createHubDelegationStore } from '../../src/main/hub/delegation-store';
import type { TaskReportPayload } from '../../src/main/hub/delegation-wire';
import type { DelegationStatus } from '../../src/main/hub/protocol';

const SELF_NODE = 'node-b';
const DELEGATION_ID = 'dl-hub-1';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-worker-runner-v2-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/** 委派执行会话（真实行——human_requests.session_id 落点） */
let execSessionId = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  execSessionId = insertSession({ workspaceId: 'ws1', title: '委派执行', kind: 'task_execution' }).id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/**
 * runner harness：噪声边界（建会/回合/上报/watchTurn）fake；v2 接线三端口 =
 * 生产产品函数（真实库）；store = wrapWorkerStore 真装饰（承接行建链真实）。
 * watchTurn 仿真生产单次订阅：armed 栈 push 订阅、fire 弹出末位（生产
 * settled+clearInterval 语义——不复挂则再无回调）。
 */
function makeRunnerHarness(hubProto: string | null): {
  runner: ReturnType<typeof createDelegationRunner>;
  store: ReturnType<typeof createHubDelegationStore>;
  reports: Array<{ taskId: string; payload: TaskReportPayload }>;
  armCount: () => number;
  fireTerminal: (t: TurnTerminal) => void;
} {
  const syncPorts: DelegationSyncPorts = {
    findTaskByDelegation: (delegationId) => {
      const row = getDb()
        .prepare('SELECT id FROM tasks WHERE delegation_id = ?')
        .get(delegationId) as { id: string } | undefined;
      return row ? (getTask(row.id) ?? null) : null;
    },
    updateTask: (id, patch) => {
      updateTask(id, patch);
    },
    saveProgress: () => undefined,
    getProgress: () => null,
    insertWorkerTaskRow: (input) =>
      insertTask({
        workspaceId: input.workspaceId,
        title: input.title,
        creatorUserId: '@owner:home',
        status: input.status,
        routing: input.routing,
        delegationId: input.delegationId,
        startedAt: input.startedAt,
      }).id,
    findWorkspaceByName: () => ({ id: 'ws1' }),
    selfNodeId: () => SELF_NODE,
    hubProtoVer: () => hubProto,
    now: () => Date.now(),
  };
  const rawStore = createHubDelegationStore(getDb());
  const wrappedStore = createDelegationSync(syncPorts).wrapWorkerStore(rawStore);
  const settings = createHubDelegationSettingsStore(getDb());
  settings.write({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: 15 });

  const reports: Array<{ taskId: string; payload: TaskReportPayload }> = [];
  const armed: Array<(t: TurnTerminal) => void> = [];
  let arms = 0;
  const ports: DelegationRunPorts = {
    settings: () => settings.read(),
    findWorkspaceByName: () => ({ id: 'ws1', name: 'Test' }),
    resolveAgentInstance: () => 'inst-1',
    resolveAgentInstanceByName: () => null,
    createDelegatedSession: () => execSessionId,
    applyRunPolicy: () => undefined,
    sessionWaiting: () => null,
    injectSteer: () => undefined,
    startTurn: async () => undefined,
    stopSession: () => undefined,
    watchTurn: (_sessionId, onTerminal) => {
      arms += 1;
      armed.push(onTerminal);
      return () => {
        const i = armed.indexOf(onTerminal);
        if (i >= 0) armed.splice(i, 1);
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
    linkExecutionSession: linkExecutionSessionProduct,
    startLifecycleRun: startLifecycleRunProduct,
    pendingHumanRequests: pendingHumanRequestsProduct,
  };
  const runner = createDelegationRunner({ ports, store: wrappedStore, tickMs: 500 });
  return {
    runner,
    store: wrappedStore,
    reports,
    armCount: () => arms,
    fireTerminal: (t) => {
      const fn = armed.pop();
      if (fn === undefined) throw new Error('无在挂 watcher（生产语义：单次订阅已消费）');
      fn(t);
    },
  };
}

function assignedEvt(): AssignedTaskEvent {
  return {
    taskId: DELEGATION_ID,
    workspaceName: 'Test',
    task: { title: '跨节点任务', prompt: '请实现功能并提交。' },
    byNode: 'node-leader',
  };
}

/** 本地承接行（delegation_id 反查） */
function workerRow(): { id: string; status: string; executionSessionId: string | null } {
  const row = getDb()
    .prepare('SELECT id, status, execution_session_id FROM tasks WHERE delegation_id = ?')
    .get(DELEGATION_ID) as { id: string; status: string; execution_session_id: string | null } | undefined;
  expect(row).toBeDefined();
  return { id: row!.id, status: row!.status, executionSessionId: row!.execution_session_id };
}

function runDbRow(taskId: string): { run_no: number; trigger: string; status: string; execution_session_id: string | null } {
  const row = getDb()
    .prepare('SELECT * FROM task_runs WHERE task_id = ?')
    .get(taskId) as { run_no: number; trigger: string; status: string; execution_session_id: string | null };
  expect(row).toBeDefined();
  return row;
}

/** 接线后落一条真实人工请求（agent 工具入口——按执行会话反查任务） */
function askQuestion(): string {
  const row = requestHumanFromAgent({
    sessionId: execSessionId,
    kind: 'question',
    title: '选数据库？',
    prompt: 'SQLite 还是 DuckDB？',
  });
  return row.id;
}

// ── 1) handleAssigned 接线：会话绑定 + run 落库（两象限无条件） ──────────────

describe('1) handleAssigned 接线（会话绑定 + run 行落库）', () => {
  for (const [label, hubProto] of [
    ['twoPhase（hub 1.11.0）', '1.11.0'],
    ['降级（hub 未知）', null],
  ] as const) {
    it(`${label}：execution_session_id 回写 + runNo 1 / trigger initial + in_progress 投影`, async () => {
      const h = makeRunnerHarness(hubProto);
      await h.runner.handleAssigned(assignedEvt());

      const row = workerRow();
      expect(row.executionSessionId).toBe(execSessionId);
      expect(row.status).toBe('in_progress');

      const run = runDbRow(row.id);
      expect(run.run_no).toBe(1);
      expect(run.trigger).toBe('initial');
      expect(run.status).toBe('running');
      expect(run.execution_session_id).toBe(execSessionId);
      expect(getTask(row.id)!.currentRunId).toBe(getActiveRun(row.id)!.id);

      expect(h.store.get(DELEGATION_ID)!.state).toBe('running');
      h.runner.destroy();
    });
  }

  it('接线幂等：同 delegation 重复 assigned 被既有幂等闸拦（不建第二 run）', async () => {
    const h = makeRunnerHarness('1.11.0');
    await h.runner.handleAssigned(assignedEvt());
    await h.runner.handleAssigned(assignedEvt());

    const row = workerRow();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ?').get(row.id)).toEqual({ n: 1 });
    h.runner.destroy();
  });
});

// ── 2) request_human 按执行会话反查任务命中 ──────────────────────────────────

describe('2) requestHuman（agent 工具入口）→ 请求绑 task + run、任务 waiting_human', () => {
  it('请求带 task_id + run_id；任务与 run 均 waiting_human', async () => {
    const h = makeRunnerHarness('1.11.0');
    await h.runner.handleAssigned(assignedEvt());

    const requestId = askQuestion();
    const row = workerRow();
    const reqs = listByTask(row.id).filter((r) => r.id === requestId);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.kind).toBe('question');
    expect(reqs[0]!.taskId).toBe(row.id);
    expect(reqs[0]!.runId).toBe(getActiveRun(row.id)!.id);
    expect(reqs[0]!.status).toBe('pending');

    expect(getTask(row.id)!.status).toBe('waiting_human');
    expect(getActiveRun(row.id)!.status).toBe('waiting_human');
    h.runner.destroy();
  });
});

// ── 3) settleRun done 守卫：等待人工的回合不误报 done ────────────────────────

describe('3) 回合终态 done + 未决请求 → 不结算不报 + watcher 复挂', () => {
  it('done 不上报、账本保持 running、复挂新订阅；failed 不守卫照报', async () => {
    const h = makeRunnerHarness('1.11.0');
    await h.runner.handleAssigned(assignedEvt());
    const armsAfterStart = h.armCount();
    askQuestion();

    h.fireTerminal({ status: 'done' });
    expect(h.reports.find((r) => r.taskId === DELEGATION_ID && r.payload.status === 'done')).toBeUndefined();
    expect(h.store.get(DELEGATION_ID)!.state).toBe('running');
    expect(h.armCount()).toBe(armsAfterStart + 1); // 复挂（生产单次订阅语义）

    h.runner.destroy();
  });

  it('failed 终态不守卫（agent 真失败照报）', async () => {
    const h = makeRunnerHarness('1.11.0');
    await h.runner.handleAssigned(assignedEvt());
    askQuestion();

    h.fireTerminal({ status: 'failed', error: 'provider 401' });
    expect(h.reports.find((r) => r.taskId === DELEGATION_ID && r.payload.status === 'failed')).toBeDefined();
    expect(h.store.get(DELEGATION_ID)!.state).toBe('failed');
    h.runner.destroy();
  });
});

// ── 4) 请求被答 → 下一终态正常结算 ──────────────────────────────────────────

describe('4) answerHuman 后注入新回合 → 终态 done 无未决 → 正常结算报 done', () => {
  it('答后任务回 in_progress、run 回 running；下一 done 正常上报 + 账本 done', async () => {
    const h = makeRunnerHarness('1.11.0');
    await h.runner.handleAssigned(assignedEvt());
    const requestId = askQuestion();

    h.fireTerminal({ status: 'done' }); // 等待拍：不结算
    answerHuman(requestId, { text: '用 SQLite' }, 'test:origin');
    const row = workerRow();
    expect(getTask(row.id)!.status).toBe('in_progress');
    expect(getActiveRun(row.id)!.status).toBe('running');

    // 新回合终态（答复注入后 agent 完成收尾）——无未决 → 正常结算
    h.fireTerminal({ status: 'done' });
    expect(h.reports.find((r) => r.taskId === DELEGATION_ID && r.payload.status === 'done')).toBeDefined();
    expect(h.store.get(DELEGATION_ID)!.state).toBe('done');
    h.runner.destroy();
  });

  it('连续两问：第一答后第二问再次挂起，第二答后正常结算（守卫循环）', async () => {
    const h = makeRunnerHarness('1.11.0');
    await h.runner.handleAssigned(assignedEvt());

    const q1 = askQuestion();
    h.fireTerminal({ status: 'done' });
    answerHuman(q1, { text: '继续' }, 'test:origin');

    const q2 = askQuestion();
    h.fireTerminal({ status: 'done' }); // 第二问挂起：仍不结算
    expect(h.reports.find((r) => r.taskId === DELEGATION_ID && r.payload.status === 'done')).toBeUndefined();
    answerHuman(q2, { text: '收尾' }, 'test:origin');

    h.fireTerminal({ status: 'done' });
    expect(h.reports.find((r) => r.taskId === DELEGATION_ID && r.payload.status === 'done')).toBeDefined();
    h.runner.destroy();
  });
});

// ── 5) submit_task 停靠：答后 submitRun → 回合终态停靠待验收 ─────────────────

describe('5) submit_task 路径：submitRun 后回合终态停靠（S2 语义在 v2 接线下回归）', () => {
  it('submitRun → done 终态停靠（不上报）→ settleAcceptance 出清', async () => {
    const h = makeRunnerHarness('1.11.0'); // twoPhase：承接行无 auto_accept，submitted 停得住
    await h.runner.handleAssigned(assignedEvt());
    const requestId = askQuestion();
    h.fireTerminal({ status: 'done' }); // 等待拍
    answerHuman(requestId, { text: '可以提交' }, 'test:origin');

    const row = workerRow();
    await submitRun(row.id, { summary: '交付说明' });
    expect(getTask(row.id)!.status).toBe('submitted');
    expect(getActiveRun(row.id)!.status).toBe('submitted');

    h.fireTerminal({ status: 'done' });
    // 停靠：不上报终态、账本保持 running（验收权威在发起方）
    expect(h.reports.find((r) => r.taskId === DELEGATION_ID && r.payload.status === 'done')).toBeUndefined();
    expect(h.store.get(DELEGATION_ID)!.state).toBe('running');

    // S4 验收消费 → 停靠出清 + 账本 done
    h.runner.settleAcceptance(DELEGATION_ID, 'accepted');
    expect(h.store.get(DELEGATION_ID)!.state).toBe('done');
    expect(h.reports.find((r) => r.taskId === DELEGATION_ID && r.payload.status === 'done')).toBeUndefined();
    h.runner.destroy();
  });
});

// ── 6) waiting 映射四象限 ────────────────────────────────────────────────────

describe('6) waiting 映射四象限（mapHubStatus + leader 侧 sync 拍）', () => {
  it('mapHubStatus：waiting 两象限分流、其余七态同值', () => {
    expect(mapHubStatus('waiting', true)).toBe('waiting_human');
    expect(mapHubStatus('waiting', false)).toBe('in_progress');
    const rest: DelegationStatus[] = ['pending', 'running', 'submitted', 'done', 'failed', 'cancelled', 'interrupted'];
    for (const s of rest) {
      expect(mapHubStatus(s, true)).toBe(mapHubStatus(s, false));
    }
  });

  /** leader 侧外派行（'out' 戳 + delegation_id 挂接）+ 真实 sync 端口 */
  function seedOutRow(): string {
    const t = insertTask({
      workspaceId: 'ws1',
      title: '外派任务',
      creatorUserId: '@owner:home',
      status: 'in_progress',
      delegationId: DELEGATION_ID,
      routing: { mode: 'node', groupId: 'g-1', targetNodeId: 'node-b' },
    });
    updateTask(t.id, { delegationRole: 'out' });
    return t.id;
  }

  function leaderSync(hubProto: string | null): ReturnType<typeof createDelegationSync> {
    const ports: DelegationSyncPorts = {
      findTaskByDelegation: (delegationId) => {
        const row = getDb()
          .prepare(`SELECT id FROM tasks WHERE delegation_id = ? AND delegation_role = 'out'`)
          .get(delegationId) as { id: string } | undefined;
        return row ? (getTask(row.id) ?? null) : null;
      },
      updateTask: (id, patch) => {
        updateTask(id, patch);
      },
      saveProgress: () => undefined,
      getProgress: () => null,
      insertWorkerTaskRow: () => {
        throw new Error('leader 侧不建承接行');
      },
      findWorkspaceByName: () => ({ id: 'ws1' }),
      selfNodeId: () => 'node-leader',
      hubProtoVer: () => hubProto,
      now: () => Date.now(),
    };
    return createDelegationSync(ports);
  }

  it('twoPhase：waiting-input 拍 → 行 waiting_human；恢复拍 → in_progress', () => {
    const taskId = seedOutRow();
    const sync = leaderSync('1.11.0');

    sync.handleProgress({ taskId: DELEGATION_ID, lastSeq: 5, excerpt: '等待用户确认', kind: 'waiting-input' });
    expect(getTask(taskId)!.status).toBe('waiting_human');

    sync.handleProgress({ taskId: DELEGATION_ID, lastSeq: 6, excerpt: '已恢复执行' });
    expect(getTask(taskId)!.status).toBe('in_progress');
  });

  it('降级：waiting-input 拍 → 行 in_progress（P1 旧行为零变化）', () => {
    const taskId = seedOutRow();
    const sync = leaderSync(null);

    sync.handleProgress({ taskId: DELEGATION_ID, lastSeq: 5, excerpt: '等待用户确认', kind: 'waiting-input' });
    expect(getTask(taskId)!.status).toBe('in_progress');
  });
});
