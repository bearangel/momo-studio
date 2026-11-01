// electron/tests/hub/delegation-sync.test.ts
//
// M2.1 Task 9：外派投影状态回写（delegation-sync）。锁什么：
//   Part A（纯注入 fake ports）：六态映射矩阵（hub 委派态 → tasks 行状态）、
//     终态粘滞（迟到事件不回退）、interrupted→pending 特判（等待续传语义 +
//     进度摘要行呈现中断）、progress excerpt 落 kv、未知 delegationId 静默；
//   Part B（worker 侧 store 包装，纯注入）：upsert(running) 建行（routing
//     targetNodeId=本机视角、delegationId=hub taskId）幂等、updateState 四态
//     同步、workspace 缺失不建行不抛；
//   Part C（retryDispatch，纯注入）：失败重派换 delegation_id、待派发重试、
//     无候选/瞬断留待处理（RM-M21-5）、门控（local/非可重试态/行不存在人话拒）；
//   Part D（真 migrations 内存库）：进度摘要 kv store 读写/覆盖/脏 JSON 容错。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMigrations } from '../../src/main/storage/migrations';
import {
  DELEGATION_STATUS_TO_TASK,
  INTERRUPTED_SUMMARY,
  createDelegationProgressStore,
  createDelegationSync,
  retryDispatch,
  type DelegationProgressEntry,
  type DelegationSyncPorts,
  type RedispatchPorts,
} from '../../src/main/hub/delegation-sync';
import type { TaskRouting } from '../../src/main/hub/task-routing';
import type { TaskRow, TaskStatus } from '../../src/main/storage/tasks/repo';
import type { DelegationRecord, HubDelegationStore } from '../../src/main/hub/delegation-store';

// ── fixtures ───────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

function mkRow(partial: Partial<TaskRow> & Pick<TaskRow, 'id' | 'title'>): TaskRow {
  return {
    origin: 'user',
    workspaceId: 'ws-1',
    description: '',
    status: 'pending',
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'owner',
    executionSessionId: null,
    assigneeAgentId: null,
    targetTeamId: null,
    targetSessionId: null,
    recurrenceParentId: null,
    priority: 0,
    scheduledAt: null,
    recurrenceRule: null,
    deadlineAt: null,
    queuePosition: null,
    runtimeInstanceId: null,
    estimatedTokens: null,
    actualTokens: null,
    toolCallsUsed: 0,
    errorMessage: null,
    createdAt: 1000,
    updatedAt: 1000,
    startedAt: null,
    completedAt: null,
    groupId: null,
    pinnedAt: null,
    archivedAt: null,
    routing: { mode: 'local' },
    delegationId: null,
    parentTaskId: null,
    ...partial,
  };
}

interface FakeWorld {
  rows: Map<string, TaskRow>;
  progress: Map<string, DelegationProgressEntry>;
  ports: DelegationSyncPorts;
}

function makeWorld(rowSeeds: TaskRow[] = [], selfNodeId: string | null = 'node-self'): FakeWorld {
  const rows = new Map<string, TaskRow>(rowSeeds.map((r) => [r.id, r]));
  const progress = new Map<string, DelegationProgressEntry>();
  const ports: DelegationSyncPorts = {
    findTaskByDelegation: (delegationId) =>
      [...rows.values()].find((r) => r.delegationId === delegationId) ?? null,
    updateTask: (id, patch) => {
      const prev = rows.get(id);
      if (prev) rows.set(id, { ...prev, ...patch });
    },
    saveProgress: (delegationId, entry) => progress.set(delegationId, entry),
    getProgress: (delegationId) => progress.get(delegationId) ?? null,
    insertWorkerTaskRow: (input) => {
      const id = `W-${rows.size + 1}`;
      rows.set(
        id,
        mkRow({
          id,
          workspaceId: input.workspaceId,
          title: input.title,
          status: input.status,
          routing: input.routing,
          delegationId: input.delegationId,
          startedAt: input.startedAt,
        }),
      );
      return id;
    },
    findWorkspaceByName: (name) => (name === 'dev-ws' ? { id: 'ws-1' } : null),
    selfNodeId: () => selfNodeId,
    now: () => NOW,
  };
  return { rows, progress, ports };
}

/** 已派发的外派行基线（dispatch-submit 落 pending 后首拍 running 到达） */
function delegatedRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return mkRow({
    id: 'T-100',
    title: '批量重命名 legacy API 端点',
    status: 'pending',
    routing: { mode: 'group', groupId: 'g1' },
    delegationId: 'hub-task-1',
    ...overrides,
  });
}

function mkRecord(overrides: Partial<DelegationRecord> = {}): DelegationRecord {
  return {
    taskId: 'hub-task-9',
    sessionId: 'sess-9',
    workspaceId: 'ws-1',
    workspaceName: 'dev-ws',
    title: '为支付回调写集成测试',
    byNode: 'node-leader',
    state: 'running',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** 最小 delegation store fake（wrap 只依赖 get/upsert/updateState 语义——reason 落形仿真真 store） */
function fakeStore(records: DelegationRecord[] = []): HubDelegationStore {
  const map = new Map(records.map((r) => [r.taskId, r]));
  return {
    get: (taskId) => map.get(taskId) ?? null,
    upsert: (record) => map.set(record.taskId, record),
    updateState: (taskId, state, reason) => {
      const prev = map.get(taskId);
      if (!prev) return;
      const next = { ...prev, state, updatedAt: NOW };
      if (state === 'failed' && typeof reason === 'string') next.reason = reason;
      map.set(taskId, next);
    },
    list: () => [...map.values()],
  };
}

// ── Part A：leader 侧七态映射矩阵 + 粘滞 + 进度摘要 ─────────────────────────

describe('delegation-sync — leader 侧状态回写（七态映射矩阵）', () => {
  it('A-1. 七态映射矩阵：映射表值域与看板状态枚举对齐（文档锁；M3.1 增 waiting）', () => {
    expect(DELEGATION_STATUS_TO_TASK).toEqual({
      pending: 'pending',
      running: 'in_progress',
      // M3.1 七态：waiting=running 中等待用户确认的中间态——本地行维持进行中，
      // 等待角标由 progress kv waiting 标志驱动（task.list 对账不造看板新状态）
      waiting: 'in_progress',
      done: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
      // 裁定（plan Task 9）：interrupted 不是终态失败——「等待续传」语义映射回
      // pending（待处理列），中断事实经进度摘要行呈现，不造看板新状态
      interrupted: 'pending',
    });
  });

  it('A-2. running（progress 拍）→ in_progress + 首次写 startedAt', () => {
    const w = makeWorld([delegatedRow()]);
    createDelegationSync(w.ports).handleProgress({ taskId: 'hub-task-1', lastSeq: 7, excerpt: 'src/api/v2/user.ts · 第 3/5 文件' });
    const row = w.rows.get('T-100')!;
    expect(row.status).toBe('in_progress');
    expect(row.startedAt).toBe(NOW);
    // 进度摘要落 kv（delegationId 键）
    expect(w.progress.get('hub-task-1')).toEqual({ excerpt: 'src/api/v2/user.ts · 第 3/5 文件', lastSeq: 7, at: NOW });
  });

  it('A-2b. 重复 running 拍不重复写 startedAt（保首次）', () => {
    const w = makeWorld([delegatedRow({ status: 'in_progress', startedAt: 111 })]);
    createDelegationSync(w.ports).handleProgress({ taskId: 'hub-task-1', lastSeq: 9, excerpt: '第二拍' });
    const row = w.rows.get('T-100')!;
    expect(row.status).toBe('in_progress');
    expect(row.startedAt).toBe(111);
  });

  it('A-3. done → completed + completedAt + 终态摘要', () => {
    const w = makeWorld([delegatedRow({ status: 'in_progress', startedAt: 111 })]);
    createDelegationSync(w.ports).handleTerminal('done', 'hub-task-1');
    const row = w.rows.get('T-100')!;
    expect(row.status).toBe('completed');
    expect(row.completedAt).toBe(NOW);
    expect(w.progress.get('hub-task-1')?.excerpt).toBe('已完成');
  });

  it('A-4. failed → failed + errorMessage=reason + reason 进摘要行', () => {
    const w = makeWorld([delegatedRow({ status: 'in_progress' })]);
    createDelegationSync(w.ports).handleTerminal('failed', 'hub-task-1', '执行失败:测试炸了');
    const row = w.rows.get('T-100')!;
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toBe('执行失败:测试炸了');
    expect(w.progress.get('hub-task-1')?.excerpt).toBe('执行失败:测试炸了');
  });

  it('A-5. interrupted → pending（等待续传）+ 中断摘要行；后续 running 恢复 in_progress', () => {
    const w = makeWorld([delegatedRow({ status: 'in_progress', startedAt: 111 })]);
    const sync = createDelegationSync(w.ports);
    sync.handleTerminal('interrupted', 'hub-task-1');
    expect(w.rows.get('T-100')!.status).toBe('pending');
    expect(w.progress.get('hub-task-1')?.excerpt).toBe(INTERRUPTED_SUMMARY);
    // 重连续传：running 拍把行带回进行中（合法回升，非粘滞违例）
    sync.handleProgress({ taskId: 'hub-task-1', lastSeq: 12, excerpt: '续传中' });
    expect(w.rows.get('T-100')!.status).toBe('in_progress');
  });

  it('A-6. markCancelled（taskCancel 回执）→ cancelled', () => {
    const w = makeWorld([delegatedRow({ status: 'in_progress' })]);
    createDelegationSync(w.ports).markCancelled('hub-task-1');
    expect(w.rows.get('T-100')!.status).toBe('cancelled');
  });

  it('A-7. 终态粘滞：completed 行迟到 failed/running 不回退', () => {
    const w = makeWorld([delegatedRow({ status: 'completed', completedAt: NOW })]);
    const sync = createDelegationSync(w.ports);
    sync.handleTerminal('failed', 'hub-task-1', '迟到失败');
    expect(w.rows.get('T-100')!.status).toBe('completed');
    sync.handleProgress({ taskId: 'hub-task-1', lastSeq: 99, excerpt: '迟到拍' });
    expect(w.rows.get('T-100')!.status).toBe('completed');
  });

  it('A-8. 终态粘滞：cancelled 行迟到 running 不复活', () => {
    const w = makeWorld([delegatedRow({ status: 'cancelled' })]);
    createDelegationSync(w.ports).handleProgress({ taskId: 'hub-task-1', lastSeq: 1, excerpt: 'x' });
    expect(w.rows.get('T-100')!.status).toBe('cancelled');
  });

  it('A-9. 未知 delegationId（手工 task.delegate 无看板行）→ 静默不抛', () => {
    const w = makeWorld();
    const sync = createDelegationSync(w.ports);
    expect(() => {
      sync.handleProgress({ taskId: 'unknown', lastSeq: 1, excerpt: 'x' });
      sync.handleTerminal('done', 'unknown');
      sync.markCancelled('unknown');
    }).not.toThrow();
  });

  // ── T12：leader 等待态（progress.kind='waiting-input' → 摘要 kv waiting 标志）──

  it('A-10. waiting 拍（kind=waiting-input）→ 摘要 kv waiting:true + summary 进 excerpt', () => {
    const w = makeWorld([delegatedRow({ status: 'in_progress', startedAt: 111 })]);
    createDelegationSync(w.ports).handleProgress({
      taskId: 'hub-task-1',
      lastSeq: 15,
      excerpt: 'agent 等待写授权：rm -rf node_modules',
      kind: 'waiting-input',
    });
    expect(w.progress.get('hub-task-1')).toEqual({
      excerpt: 'agent 等待写授权：rm -rf node_modules',
      lastSeq: 15,
      at: NOW,
      waiting: true,
    });
    // 行状态不动（等待仍在 running 语义内）
    expect(w.rows.get('T-100')!.status).toBe('in_progress');
  });

  it('A-11. 恢复拍（无 kind，与 runner 去 kind 同步）→ waiting 清除', () => {
    const w = makeWorld([delegatedRow({ status: 'in_progress', startedAt: 111 })]);
    const sync = createDelegationSync(w.ports);
    sync.handleProgress({ taskId: 'hub-task-1', lastSeq: 15, excerpt: '等待中', kind: 'waiting-input' });
    sync.handleProgress({ taskId: 'hub-task-1', lastSeq: 16, excerpt: '续跑产出' });
    // waiting 标志清除（仅 true 落形纪律——undefined/false 均为「非等待」）
    expect(w.progress.get('hub-task-1')?.waiting === true).toBe(false);
    expect(w.progress.get('hub-task-1')?.excerpt).toBe('续跑产出');
  });

  // ── M2.2 P2-1：denied 拍（kind='denied'）不点亮等待——文案由 excerpt 承载 ──

  it('A-11b. denied 拍（kind=denied，hub 前向预留）→ 摘要落 excerpt、waiting 不置', () => {
    const w = makeWorld([delegatedRow({ status: 'in_progress', startedAt: 111 })]);
    createDelegationSync(w.ports).handleProgress({
      taskId: 'hub-task-1',
      lastSeq: 20,
      excerpt: '只读档位即时拒绝：bash git push origin main',
      kind: 'denied',
    });
    expect(w.progress.get('hub-task-1')).toEqual({
      excerpt: '只读档位即时拒绝：bash git push origin main',
      lastSeq: 20,
      at: NOW,
    });
  });

  it('A-12. Low-1：终态同态重写不重盖章——重复 done 推送 completedAt 不变、零行写', () => {
    const w = makeWorld([delegatedRow({ status: 'in_progress', startedAt: 111 })]);
    let writes = 0;
    const baseUpdate = w.ports.updateTask;
    w.ports.updateTask = (id, patch) => {
      writes += 1;
      baseUpdate(id, patch);
    };
    const sync = createDelegationSync(w.ports);
    sync.handleTerminal('done', 'hub-task-1');
    expect(w.rows.get('T-100')!.completedAt).toBe(NOW);
    // 第二次 done（hub 账本对账重放/重复推送）——同态零写
    sync.handleTerminal('done', 'hub-task-1');
    expect(writes).toBe(1);
    expect(w.rows.get('T-100')!.completedAt).toBe(NOW);
  });

  // ── T12 修复轮：终态拍清 waiting 残留（done/cancelled 无恢复拍路径）────────

  it('A-13. 等待中授权后直接 done（无恢复拍）→ 终态摘要整条覆盖，kv 无 waiting 残留', () => {
    const w = makeWorld([delegatedRow({ status: 'in_progress', startedAt: 111 })]);
    const sync = createDelegationSync(w.ports);
    sync.handleProgress({ taskId: 'hub-task-1', lastSeq: 15, excerpt: '等待写授权', kind: 'waiting-input' });
    expect(w.progress.get('hub-task-1')?.waiting).toBe(true);
    // 授权放行 → 下一拍即 done（running 恢复拍缺席）——终态 saveProgress 覆盖整条目
    sync.handleTerminal('done', 'hub-task-1');
    expect(w.progress.get('hub-task-1')).toEqual({ excerpt: '已完成', lastSeq: 0, at: NOW });
  });

  it('A-14. 等待中取消 → markCancelled 同步清 waiting（否则等待卡对已取消任务误亮）', () => {
    const w = makeWorld([delegatedRow({ status: 'in_progress', startedAt: 111 })]);
    const sync = createDelegationSync(w.ports);
    sync.handleProgress({ taskId: 'hub-task-1', lastSeq: 15, excerpt: '等待写授权', kind: 'waiting-input' });
    sync.markCancelled('hub-task-1');
    expect(w.rows.get('T-100')!.status).toBe('cancelled');
    expect(w.progress.get('hub-task-1')).toEqual({ excerpt: '已取消', lastSeq: 0, at: NOW });
  });
});

// ── Part B：worker 侧 delegation store 包装（收委派建行 + 四态同步）────────

describe('delegation-sync — worker 侧 store 包装', () => {
  it('B-1. upsert(running) 建 tasks 行：delegationId=hub taskId、routing.targetNodeId=本机、in_progress', () => {
    const w = makeWorld();
    const wrapped = createDelegationSync(w.ports).wrapWorkerStore(fakeStore());
    wrapped.upsert(mkRecord());
    expect(w.rows.size).toBe(1);
    const row = [...w.rows.values()][0]!;
    expect(row.delegationId).toBe('hub-task-9');
    expect(row.title).toBe('为支付回调写集成测试');
    expect(row.status).toBe('in_progress');
    expect(row.routing).toEqual({ mode: 'node', groupId: '', targetNodeId: 'node-self' } satisfies TaskRouting);
    expect(row.startedAt).toBe(NOW);
  });

  it('B-2. 幂等：行已存在（重复 assigned / 重连）不重建', () => {
    const w = makeWorld();
    const wrapped = createDelegationSync(w.ports).wrapWorkerStore(fakeStore());
    wrapped.upsert(mkRecord());
    wrapped.upsert(mkRecord({ updatedAt: NOW + 5 }));
    expect(w.rows.size).toBe(1);
  });

  it('B-3. workspace 不存在 → 不建行不抛（账本照写）', () => {
    const w = makeWorld();
    const wrapped = createDelegationSync(w.ports).wrapWorkerStore(fakeStore());
    expect(() => wrapped.upsert(mkRecord({ workspaceName: 'ghost-ws' }))).not.toThrow();
    expect(w.rows.size).toBe(0);
  });

  it('B-4. updateState 四态同步：done→completed（+completedAt）、failed→failed、cancelled→cancelled', () => {
    const w = makeWorld();
    const wrapped = createDelegationSync(w.ports).wrapWorkerStore(fakeStore());
    wrapped.upsert(mkRecord());
    const id = [...w.rows.keys()][0]!;
    wrapped.updateState('hub-task-9', 'done');
    expect(w.rows.get(id)!.status).toBe('completed');
    expect(w.rows.get(id)!.completedAt).toBe(NOW);
    // 终态粘滞同样适用（迟到 updateState 不回退）
    wrapped.updateState('hub-task-9', 'running');
    expect(w.rows.get(id)!.status).toBe('completed');
  });

  it('B-4b. updateState failed → failed（无 reason 可写，errorMessage 不动）', () => {
    const w = makeWorld();
    const wrapped = createDelegationSync(w.ports).wrapWorkerStore(fakeStore());
    wrapped.upsert(mkRecord());
    const id = [...w.rows.keys()][0]!;
    wrapped.updateState('hub-task-9', 'failed');
    expect(w.rows.get(id)!.status).toBe('failed');
    expect(w.rows.get(id)!.errorMessage).toBeNull();
  });

  // ── M2.3 P2-1：worker 侧 reason 对称面（leader A-4 同款——failed 附因落 errorMessage）──

  it('B-4c. updateState failed 附 reason → tasks 行 errorMessage 落值（卡面 title 全文数据源）', () => {
    const w = makeWorld();
    const wrapped = createDelegationSync(w.ports).wrapWorkerStore(fakeStore());
    wrapped.upsert(mkRecord());
    const id = [...w.rows.keys()][0]!;
    wrapped.updateState('hub-task-9', 'failed', '执行失败:目标节点 cargo build 崩溃（os error 1）');
    const row = w.rows.get(id)!;
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toBe('执行失败:目标节点 cargo build 崩溃（os error 1）');
  });

  it('B-4d. reason 透传账本：wrapped.updateState 第三参落 store 行（与 tasks 行同源）', () => {
    const w = makeWorld();
    const inner = fakeStore();
    const wrapped = createDelegationSync(w.ports).wrapWorkerStore(inner);
    wrapped.upsert(mkRecord());
    wrapped.updateState('hub-task-9', 'failed', '执行失败:X');
    expect(inner.get('hub-task-9')?.reason).toBe('执行失败:X');
  });

  it('B-5. selfNodeId 为 null（未 enroll 完成的极端窗口）→ targetNodeId 落空串不抛', () => {
    const w = makeWorld([], null);
    const wrapped = createDelegationSync(w.ports).wrapWorkerStore(fakeStore());
    wrapped.upsert(mkRecord());
    const row = [...w.rows.values()][0]!;
    expect(row.routing).toEqual({ mode: 'node', groupId: '', targetNodeId: '' });
  });
});

// ── Part C：retryDispatch（失败重派 / 待派发重试 RM-M21-5）──────────────────

interface RedispatchWorld {
  rows: Map<string, TaskRow>;
  updates: Array<{ id: string; patch: Partial<TaskRow> }>;
  delegateCalls: Array<{ targetNodeId: string }>;
  /** M5.3：完整 brief（team 段重建断言） */
  delegateBriefs: Array<import('../../src/main/hub/dispatch-submit').DelegationTaskBrief>;
  /** M5.3：resolveTarget 收到的 opts（版本闸 team 标志透传断言） */
  resolveCalls: Array<{ team?: boolean } | undefined>;
  ports: RedispatchPorts;
}

function makeRedispatchWorld(
  row: TaskRow,
  opts: {
    target?: string | null;
    delegateError?: Error;
    /** M5.3 团队快照 fake：teamId → 快照；缺省 team-1 命中（单 agent 行不消费） */
    teamSnapshot?: { name: string; members: Array<{ agentName: string; isLeader: boolean }> } | null;
  } = {},
): RedispatchWorld {
  const rows = new Map<string, TaskRow>([[row.id, row]]);
  const updates: Array<{ id: string; patch: Partial<TaskRow> }> = [];
  const delegateCalls: Array<{ targetNodeId: string }> = [];
  const delegateBriefs: Array<import('../../src/main/hub/dispatch-submit').DelegationTaskBrief> = [];
  const resolveCalls: Array<{ team?: boolean } | undefined> = [];
  const ports: RedispatchPorts = {
    getTask: (id) => rows.get(id) ?? null,
    workspaceNameOf: (workspaceId) => (workspaceId === 'ws-1' ? 'dev-ws' : null),
    resolveTarget: async (routing, _workspaceName, resolveOpts) => {
      resolveCalls.push(resolveOpts);
      return opts.target === undefined ? 'node-b' : opts.target;
    },
    getTeamSnapshot: (_workspaceId, teamId) =>
      teamId === 'team-1' ? (opts.teamSnapshot === undefined ? teamSnapFixture() : opts.teamSnapshot) : null,
    delegate: async (brief) => {
      delegateCalls.push({ targetNodeId: brief.targetNodeId });
      delegateBriefs.push(brief);
      if (opts.delegateError) throw opts.delegateError;
      return { taskId: 'hub-new-id' };
    },
    updateTask: (id, patch) => {
      updates.push({ id, patch });
      const prev = rows.get(id);
      if (prev) rows.set(id, { ...prev, ...patch });
    },
    now: () => NOW,
  };
  return { rows, updates, delegateCalls, delegateBriefs, resolveCalls, ports };
}

/** M5.3 团队快照 fixture：两名成员恰一 leader */
function teamSnapFixture(): { name: string; members: Array<{ agentName: string; isLeader: boolean }> } {
  return {
    name: '攻坚组',
    members: [
      { agentName: 'PM', isLeader: true },
      { agentName: 'Coder', isLeader: false },
    ],
  };
}

describe('delegation-sync — retryDispatch', () => {
  it('C-1. 失败重派：复位（pending/清 error/清旧 delegationId）→ 派发 → 回写新 delegation_id（换 id）', async () => {
    const row = delegatedRow({ status: 'failed', errorMessage: '执行失败:X', delegationId: 'hub-old-id' });
    const w = makeRedispatchWorld(row);
    const result = await retryDispatch('T-100', w.ports);
    expect(result).toEqual({ dispatched: true, nodeId: 'node-b', delegationId: 'hub-new-id' });
    // 复位先于派发（updates 序列锁中间态：delegationId 先清再回写新值）；
    // 成功回写带已解析目标 routing（D5——group 变体补 targetNodeId）
    expect(w.updates.map((u) => u.patch)).toEqual([
      { status: 'pending', errorMessage: null, delegationId: null },
      { delegationId: 'hub-new-id', routing: { mode: 'group', groupId: 'g1', targetNodeId: 'node-b' } },
    ]);
    expect(w.rows.get('T-100')!.delegationId).toBe('hub-new-id');
    expect(w.rows.get('T-100')!.routing).toEqual({ mode: 'group', groupId: 'g1', targetNodeId: 'node-b' });
    expect(w.delegateCalls).toEqual([{ targetNodeId: 'node-b' }]);
  });

  it('C-2. 待派发重试（delegationId 空 + pending）：无候选 → dispatched false 行保持待处理', async () => {
    const row = delegatedRow({ status: 'pending', delegationId: null });
    const w = makeRedispatchWorld(row, { target: null });
    const result = await retryDispatch('T-100', w.ports);
    expect(result.dispatched).toBe(false);
    expect(result.nodeId).toBeNull();
    expect(w.rows.get('T-100')!.status).toBe('pending');
    expect(w.delegateCalls).toHaveLength(0); // 无候选零派发（不轮询 RM-M21-5）
  });

  it('C-3. 派发瞬断（node_offline 等）→ 不抛、行留待处理（delegationId 已清）', async () => {
    const row = delegatedRow({ status: 'failed', delegationId: 'hub-old-id' });
    const w = makeRedispatchWorld(row, { delegateError: new Error('node_offline') });
    const result = await retryDispatch('T-100', w.ports);
    expect(result.dispatched).toBe(false);
    expect(w.rows.get('T-100')!.status).toBe('pending');
    expect(w.rows.get('T-100')!.delegationId).toBeNull();
  });

  it('C-4. 门控：local 行拒绝；非 pending/failed 态拒绝；行不存在人话拒', async () => {
    const local = makeRedispatchWorld(mkRow({ id: 'T-1', title: 'x', routing: { mode: 'local' } }));
    await expect(retryDispatch('T-1', local.ports)).rejects.toThrow('本机执行的任务无需派发');

    const running = makeRedispatchWorld(delegatedRow({ status: 'in_progress' }));
    await expect(retryDispatch('T-100', running.ports)).rejects.toThrow('仅待派发或已失败的外派任务可重派');

    const missing = makeRedispatchWorld(delegatedRow());
    await expect(retryDispatch('T-404', missing.ports)).rejects.toThrow('任务 T-404 不存在');
  });
});

// ── Part C-M5.3：retryDispatch 团队重派（targetTeamId 重建 team 段） ────────

describe('delegation-sync — retryDispatch 团队重派（M5.3）', () => {
  it('CM-1. 行带 targetTeamId → 重派载荷带 team 段（当前快照展开）+ 版本闸 team 标志透传', async () => {
    const row = delegatedRow({ status: 'failed', delegationId: 'hub-old-id', targetTeamId: 'team-1' });
    const w = makeRedispatchWorld(row);
    const result = await retryDispatch('T-100', w.ports);

    expect(result).toEqual({ dispatched: true, nodeId: 'node-b', delegationId: 'hub-new-id' });
    // team 段按当前快照重建（name=agentName + leader 标记）；不带 agentSlug 键
    expect(w.delegateBriefs).toHaveLength(1);
    expect(w.delegateBriefs[0]!.task.team).toEqual({
      members: [
        { name: 'PM', isLeader: true },
        { name: 'Coder', isLeader: false },
      ],
    });
    expect('agentSlug' in w.delegateBriefs[0]!.task).toBe(false);
    // 版本闸与首派同构：resolveTarget 收到 {team:true}
    expect(w.resolveCalls).toEqual([{ team: true }]);
  });

  it('CM-2. 团队已解散（快照 null）→ 不派不分流，行转 failed 人话（不闪 pending）', async () => {
    const row = delegatedRow({ status: 'pending', delegationId: null, targetTeamId: 'team-gone' });
    const w = makeRedispatchWorld(row);
    const result = await retryDispatch('T-100', w.ports);

    expect(result).toEqual({ dispatched: false, nodeId: null, delegationId: null });
    expect(w.delegateCalls).toHaveLength(0);
    // 唯一一次 update 即终态 failed（复位 update 不得先行——错误路径零副作用）
    expect(w.updates).toEqual([
      {
        id: 'T-100',
        patch: {
          status: 'failed',
          errorMessage: '目标团队已解散，无法重派（原派发：团队协作）',
          completedAt: NOW,
        },
      },
    ]);
    expect(w.rows.get('T-100')!.status).toBe('failed');
  });

  it('CM-3. 团队形态失效（单成员）→ 同 failed 人话（附展开单源附因），不派', async () => {
    const row = delegatedRow({ status: 'failed', targetTeamId: 'team-1' });
    const w = makeRedispatchWorld(row, {
      teamSnapshot: { name: '独行侠', members: [{ agentName: 'PM', isLeader: true }] },
    });
    const result = await retryDispatch('T-100', w.ports);

    expect(result.dispatched).toBe(false);
    expect(w.delegateCalls).toHaveLength(0);
    const patch = w.updates[0]!.patch;
    expect(patch.status).toBe('failed');
    expect(patch.errorMessage).toContain('目标团队已解散，无法重派（原派发：团队协作）');
    expect(patch.errorMessage).toContain('形态不满足团队派发');
  });

  it('CM-4. 单 agent 行（targetTeamId 空）重派零变化：无 team 键、无 team 闸、brief 形状同旧', async () => {
    const row = delegatedRow({ status: 'failed', delegationId: 'hub-old-id' });
    const w = makeRedispatchWorld(row);
    const result = await retryDispatch('T-100', w.ports);

    expect(result).toEqual({ dispatched: true, nodeId: 'node-b', delegationId: 'hub-new-id' });
    expect('team' in w.delegateBriefs[0]!.task).toBe(false);
    expect(w.resolveCalls).toEqual([{ team: false }]); // 闸不启用（team:false 与缺省等价）
    expect(w.delegateBriefs[0]!.task).toEqual({
      title: '批量重命名 legacy API 端点',
      prompt: '批量重命名 legacy API 端点',
      permissionTier: 'confirm',
    });
  });
});

// ── Part D：进度摘要 kv store（真 migrations 内存库）─────────────────────────

function newTmpDb(): DB {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-delegation-sync-'));
  const db = new Database(path.join(dir, 't.db'));
  db.pragma('foreign_keys = ON');
  for (const mig of loadMigrations()) db.exec(mig.sql);
  return db;
}

describe('createDelegationProgressStore（kv 持久）', () => {
  it('D-1. save 覆盖同键 / get 命中 / list 全量 / 未知键 null', () => {
    const store = createDelegationProgressStore(newTmpDb());
    expect(store.get('d1')).toBeNull();
    store.save('d1', { excerpt: '第一拍', lastSeq: 3, at: 1 });
    store.save('d1', { excerpt: '第二拍', lastSeq: 8, at: 2 });
    expect(store.get('d1')).toEqual({ excerpt: '第二拍', lastSeq: 8, at: 2 });
    store.save('d2', { excerpt: '另一任务', lastSeq: 1, at: 3 });
    expect(store.list()).toEqual({
      d1: { excerpt: '第二拍', lastSeq: 8, at: 2 },
      d2: { excerpt: '另一任务', lastSeq: 1, at: 3 },
    });
  });

  it('D-2. 脏 JSON 容错：整表按空处理（委派可重派不炸读取方）', () => {
    const db = newTmpDb();
    db.prepare(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ('hub_delegation_progress', '{bad json', datetime('now'))`,
    ).run();
    const store = createDelegationProgressStore(db);
    expect(store.list()).toEqual({});
    expect(store.get('d1')).toBeNull();
  });

  it('D-3. 异形条目剔除、合法条目保留（先验形状——持久化面不渗杂字段）', () => {
    const db = newTmpDb();
    const dirty = JSON.stringify({
      ok: { excerpt: '好条目', lastSeq: 1, at: 1 },
      bad: { excerpt: 123 },
      worse: 'not-an-object',
    });
    db.prepare(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ('hub_delegation_progress', ?, datetime('now'))`,
    ).run(dirty);
    const store = createDelegationProgressStore(db);
    expect(store.list()).toEqual({ ok: { excerpt: '好条目', lastSeq: 1, at: 1 } });
  });
});

// ── Part E：远程代答留痕（M3.1——handleAnswered + answered 保守解析）─────────

describe('delegation-sync — handleAnswered（task.answered → kv 留痕）', () => {
  it('E-1. 既有条目合并写 answered：excerpt/lastSeq/at 保留（行状态不动），at=now', () => {
    const w = makeWorld([delegatedRow({ status: 'in_progress' })]);
    const sync = createDelegationSync(w.ports);
    sync.handleProgress({ taskId: 'hub-task-1', lastSeq: 5, excerpt: '等待批准写入', kind: 'waiting-input' });
    sync.handleAnswered({ taskId: 'hub-task-1', decision: 'approve' });
    expect(w.progress.get('hub-task-1')).toEqual({
      excerpt: '等待批准写入',
      lastSeq: 5,
      at: NOW,
      waiting: true,
      answered: { decision: 'approve', at: NOW },
    });
    // 行状态不动（hub 代答不迁移账本——waiting↔running 单由 worker 上报驱动）
    expect(w.rows.get('T-100')!.status).toBe('in_progress');
  });

  it('E-2. 无既有条目（委派未开跑/无看板行）→ 静默无落点，不新建条目不抛', () => {
    const w = makeWorld([delegatedRow()]);
    createDelegationSync(w.ports).handleAnswered({ taskId: 'hub-task-unknown', decision: 'deny' });
    expect(w.progress.size).toBe(0);
  });

  it('E-3. 后续进度拍自然清除 answered（整条覆写——卡片「较新才显示」的 kv 侧对偶）', () => {
    const w = makeWorld([delegatedRow({ status: 'in_progress' })]);
    const sync = createDelegationSync(w.ports);
    sync.handleProgress({ taskId: 'hub-task-1', lastSeq: 5, excerpt: '等待批准写入', kind: 'waiting-input' });
    sync.handleAnswered({ taskId: 'hub-task-1', decision: 'deny' });
    sync.handleProgress({ taskId: 'hub-task-1', lastSeq: 6, excerpt: '续跑产出' });
    expect(w.progress.get('hub-task-1')).toEqual({ excerpt: '续跑产出', lastSeq: 6, at: NOW });
  });
});

describe('createDelegationProgressStore — answered 保守解析（M3.1）', () => {
  it('E-4. 合法 answered 落形保留；异形（decision 非枚举 / at 非数字 / 缺字段）整字段丢弃，条目其余部分不损', () => {
    const db = newTmpDb();
    const dirty = JSON.stringify({
      ok: { excerpt: '好条目', lastSeq: 1, at: 1, waiting: true, answered: { decision: 'approve', at: 9 } },
      badDecision: { excerpt: 'b', lastSeq: 1, at: 1, answered: { decision: 'maybe', at: 9 } },
      badAt: { excerpt: 'c', lastSeq: 1, at: 1, answered: { decision: 'deny', at: '9' } },
      noAt: { excerpt: 'd', lastSeq: 1, at: 1, answered: { decision: 'deny' } },
    });
    db.prepare(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ('hub_delegation_progress', ?, datetime('now'))`,
    ).run(dirty);
    const store = createDelegationProgressStore(db);
    expect(store.list()).toEqual({
      ok: { excerpt: '好条目', lastSeq: 1, at: 1, waiting: true, answered: { decision: 'approve', at: 9 } },
      badDecision: { excerpt: 'b', lastSeq: 1, at: 1 },
      badAt: { excerpt: 'c', lastSeq: 1, at: 1 },
      noAt: { excerpt: 'd', lastSeq: 1, at: 1 },
    });
  });
});

// ── 类型 sanity：TaskStatus 值域引用（防映射表漂移到不存在状态）──────────────

it('映射表值域 ∈ 看板九态', () => {
  const valid: ReadonlySet<TaskStatus> = new Set([
    'draft', 'pending', 'assigned', 'session_queued', 'in_progress',
    'paused', 'completed', 'failed', 'cancelled',
  ]);
  for (const s of Object.values(DELEGATION_STATUS_TO_TASK)) expect(valid.has(s)).toBe(true);
});

// ── Part E：retryDispatch blocked 派发闸（M3.3 spec §2.1）────────────────────
// 门控口径：仅 completed 解锁；blocked 为 getTask 派生态（生产接线 repo.getTask
// 已聚合；本文件纯注入 world 的行按真实派生形状构造）。
describe('delegation-sync — retryDispatch blocked 闸（M3.3）', () => {
  it('E-1. 存在未完成依赖（pending/failed 态均可命中）→ 人话拒绝，行零复位零派发', async () => {
    const row = delegatedRow({ status: 'failed', blocked: true, blockedBy: ['T-2'] });
    const w = makeRedispatchWorld(row);
    await expect(retryDispatch('T-100', w.ports)).rejects.toThrow(
      '任务存在未完成依赖（T-2），依赖完成前不可派发',
    );
    expect(w.updates).toHaveLength(0); // 拒绝先于复位写
    expect(w.delegateCalls).toHaveLength(0);
  });

  it('E-2. 门序：blocked 检查在状态门之后（合法态 + blocked → 拒；非法态仍先报状态错）', async () => {
    // in_progress 行（状态门先拒，blocked 信息不出场）
    const running = makeRedispatchWorld(delegatedRow({ status: 'in_progress', blocked: true }));
    await expect(retryDispatch('T-100', running.ports)).rejects.toThrow(
      '仅待派发或已失败的外派任务可重派',
    );
    // pending（合法待重派态）+ blocked → blocked 门拒
    const pendingBlocked = makeRedispatchWorld(
      delegatedRow({ status: 'pending', delegationId: null, blocked: true, blockedBy: ['T-9'] }),
    );
    await expect(retryDispatch('T-100', pendingBlocked.ports)).rejects.toThrow('存在未完成依赖');
  });

  it('E-3. 无依赖（blocked 缺省）→ 既有重派链路不受闸影响', async () => {
    const row = delegatedRow({ status: 'failed', errorMessage: '执行失败:X', delegationId: 'hub-old-id' });
    const w = makeRedispatchWorld(row);
    const result = await retryDispatch('T-100', w.ports);
    expect(result.dispatched).toBe(true);
  });
});
