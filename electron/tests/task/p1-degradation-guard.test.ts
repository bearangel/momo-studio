// electron/tests/task/p1-degradation-guard.test.ts
//
// P1 降级守卫回归锁（spec 2026-11-13-task-lifecycle-v2 §14 + §5.1 不变量 7，
// Task 18）——P1 期间 delegation_role IS NOT NULL 的任务强制 auto_accept=1 且
// 完成走旧单方语义（done→completed 不经 submitted），P2 移除。四组锁：
//   1. dispatch-submit 委派成功 → 行 delegation_role='out' + auto_accept=1
//      （真 DB 落行断言；createRemoteTask/updateDelegationLink 端口按生产
//      dispatch-ports.ts 同形接线——网络边界（listGroups/delegate）fake）
//   2. delegation-sync done 拍 → 直接 completed（不经 submitted）+ accepted_at
//      同刻落账（纯注入 fake ports——delegation-sync 唯一 mock 面）
//   3. worker ensureRow → delegation_role='in' + auto_accept=1（insertTask 不含
//      delegation_role 列——经 updateTask 补戳）
//   4. executor admitOnce 跳过 delegation_role='out' 的 assigned 行（本地不
//      重复拉起外派任务；真 DB + 真 executor，仅 kickoff 注入 fake）
//   外加：retryDispatch 重派成功补 out 戳（首派失败留待处理的行无戳→守卫闭环）。
// task:update 剥 status 用例已在 tests/task/ipc-handlers.test.ts（minor-11 三
// 用例）覆盖，此处不重复。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, updateTask } from '../../src/main/storage/tasks/repo';
import { submitRoutedTask } from '../../src/main/hub/dispatch-submit';
import { retryDispatch, createDelegationSync, type DelegationSyncPorts } from '../../src/main/hub/delegation-sync';
import { TaskExecutor } from '../../src/main/task/executor';
import type { ExecutorDeps } from '../../src/main/task/executor';
import type { TaskRow } from '../../src/main/storage/tasks/repo';
import type { TaskRouting } from '../../src/main/hub/task-routing';
import type { DelegationRecord, HubDelegationStore } from '../../src/main/hub/delegation-store';
import type { DelegationProgressEntry } from '../../src/main/hub/delegation-sync';

const NOW = 1_700_000_000_000;

const tmpRoot = path.join(os.tmpdir(), `ap-p1guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'Test', '/tmp', '@owner:home')`)
    .run();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// ── 第 1 组：dispatch-submit 委派成功落 out 戳（真 DB） ─────────────────────

/** 生产同形端口（dispatch-ports.ts）：网络边界 fake，落库走真 insertTask/updateTask */
function productionShapedPorts(opts?: { delegateError?: Error; online?: boolean; delegateId?: string }) {
  return {
    listGroups: vi.fn().mockResolvedValue([
      {
        groupId: 'g1',
        groupName: 'dev-team',
        members: [
          { nodeId: 'node-a', name: 'office-mac', online: opts?.online ?? true },
        ],
      },
    ]),
    hubProtoVer: vi.fn().mockReturnValue('1.9.0'),
    getTeamSnapshot: vi.fn().mockReturnValue(null),
    listDelegations: vi.fn().mockResolvedValue([]),
    listMirrorRegistry: vi.fn().mockReturnValue([
      { groupId: 'g1', targetNodeId: 'node-a', workspaceName: 'ws-main' },
    ]),
    delegate: opts?.delegateError
      ? vi.fn().mockRejectedValue(opts.delegateError)
      : vi.fn().mockResolvedValue({ taskId: opts?.delegateId ?? 'dl-guard-1' }),
    createLocalTask: vi.fn().mockImplementation((input: { routing: TaskRouting }) =>
      insertTask({
        workspaceId: 'ws1',
        title: '本地任务',
        creatorUserId: 'owner',
        status: 'draft',
        routing: input.routing,
      }),
    ),
    createRemoteTask: vi.fn().mockImplementation((input: { routing: TaskRouting }) =>
      insertTask({
        workspaceId: 'ws1',
        title: '外派任务',
        creatorUserId: 'owner',
        status: 'pending',
        routing: input.routing,
      }),
    ),
    deriveBlockedBy: vi.fn().mockReturnValue([]),
    // 生产同形（dispatch-ports.ts）：P1 行戳随 delegation_id/routing 一并落行
    updateDelegationLink: vi.fn().mockImplementation(
      (taskId: string, delegationId: string, routing: TaskRouting, p1Stamp: { delegationRole: 'out'; autoAccept: true }) => {
        updateTask(taskId, { delegationId, routing, ...p1Stamp });
      },
    ),
  };
}

function routedInput(routing: TaskRouting): Parameters<typeof submitRoutedTask>[0] {
  return {
    workspaceId: 'ws1',
    workspaceName: 'ws-main',
    title: '排查 WebSocket 断连',
    description: '分析 gateway 日志',
    routing,
  };
}

describe('P1 降级守卫 — dispatch-submit 落 out 戳（spec §14）', () => {
  it('1a. 委派成功 → 行 delegation_role=out + auto_accept=1 + delegation_id 回写', async () => {
    const ports = productionShapedPorts();
    const result = await submitRoutedTask(
      routedInput({ mode: 'node', groupId: 'g1', targetNodeId: 'node-a' }),
      ports,
    );

    expect(result.dispatched).toBe(true);
    const row = getTask(result.task.id)!;
    expect(row.delegationId).toBe('dl-guard-1');
    expect(row.delegationRole).toBe('out');
    expect(row.autoAccept).toBe(true);
  });

  it('1b. local 模式创建零 hub 交互 → 行不戳（delegationRole 保持 null）', async () => {
    const ports = productionShapedPorts();
    const result = await submitRoutedTask(routedInput({ mode: 'local' }), ports);

    expect(result.dispatched).toBe(false);
    expect(ports.updateDelegationLink).not.toHaveBeenCalled();
    const row = getTask(result.task.id)!;
    expect(row.delegationRole).toBeNull();
    expect(row.autoAccept).toBe(false);
  });

  it('1c. 派发瞬断（node_offline）→ 行留待处理不落 out 戳（守卫随成功回写生效）', async () => {
    const ports = productionShapedPorts({ delegateError: new Error('node_offline') });
    const result = await submitRoutedTask(
      routedInput({ mode: 'node', groupId: 'g1', targetNodeId: 'node-a' }),
      ports,
    );

    expect(result.dispatched).toBe(false);
    const row = getTask(result.task.id)!;
    expect(row.delegationId).toBeNull();
    expect(row.delegationRole).toBeNull();
  });
});

// ── 第 1 组附加：retryDispatch 重派成功补 out 戳 ───────────────────────────

describe('P1 降级守卫 — retryDispatch 重派成功补 out 戳', () => {
  it('1d. 首派失败无戳行 → 重派成功后 delegation_role=out + auto_accept=1', async () => {
    // 首派失败（瞬断）留待处理→失败的行：无 delegation_id 也无 delegation_role
    const row = insertTask({
      workspaceId: 'ws1',
      title: '重派任务',
      creatorUserId: 'owner',
      status: 'failed',
      errorMessage: 'node_offline',
      routing: { mode: 'node', groupId: 'g1', targetNodeId: 'node-a' },
    });
    const ports = {
      getTask: (id: string) => getTask(id),
      workspaceNameOf: () => 'ws-main',
      resolveTarget: vi.fn().mockResolvedValue('node-b'),
      getTeamSnapshot: vi.fn().mockReturnValue(null),
      delegate: vi.fn().mockResolvedValue({ taskId: 'dl-guard-new' }),
      isPeerGroup: vi.fn().mockResolvedValue(false),
      updateTask: (id: string, patch: Partial<TaskRow>) => updateTask(id, patch),
      now: () => NOW,
    };
    const result = await retryDispatch(row.id, ports);

    expect(result.dispatched).toBe(true);
    const after = getTask(row.id)!;
    expect(after.delegationId).toBe('dl-guard-new');
    expect(after.delegationRole).toBe('out');
    expect(after.autoAccept).toBe(true);
  });
});

// ── 第 2/3 组：delegation-sync（纯注入 fake ports——唯一 mock 面） ───────────

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
    currentRunId: null,
    submittedAt: null,
    acceptedAt: null,
    delegationRole: null,
    autoAccept: false,
    groupId: null,
    pinnedAt: null,
    archivedAt: null,
    routing: { mode: 'local' },
    delegationId: null,
    parentTaskId: null,
    ...partial,
  };
}

function makeSyncWorld(): { rows: Map<string, TaskRow>; progress: Map<string, DelegationProgressEntry>; ports: DelegationSyncPorts } {
  const rows = new Map<string, TaskRow>();
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
    // 仿真生产 insertTask 语义：delegation_role 列不在 INSERT 列清单——落行无戳
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
    selfNodeId: () => 'node-self',
    now: () => NOW,
  };
  return { rows, progress, ports };
}

describe('P1 降级守卫 — done 拍保持旧单方完成语义（spec §14）', () => {
  it('2a. done → 直接 completed（不经 submitted）+ accepted_at 与 completed_at 同刻', () => {
    const w = makeSyncWorld();
    w.rows.set(
      'T-out',
      mkRow({
        id: 'T-out',
        title: '外派行',
        status: 'in_progress',
        startedAt: 111,
        delegationId: 'hub-done-1',
        delegationRole: 'out',
        autoAccept: true,
      }),
    );
    createDelegationSync(w.ports).handleTerminal('done', 'hub-done-1');

    const row = w.rows.get('T-out')!;
    expect(row.status).toBe('completed');
    expect(row.completedAt).toBe(NOW);
    expect(row.acceptedAt).toBe(NOW);
    expect(row.submittedAt).toBeNull(); // 不走 submitted 两段式
  });

  it('2b. waiting 拍 → 行维持进行中 + kv waiting 标志（不造 waiting_human 新态）', () => {
    const w = makeSyncWorld();
    w.rows.set(
      'T-wait',
      mkRow({ id: 'T-wait', title: '等待行', status: 'in_progress', startedAt: 111, delegationId: 'hub-wait-1' }),
    );
    createDelegationSync(w.ports).handleProgress({
      taskId: 'hub-wait-1',
      lastSeq: 3,
      excerpt: '等待写授权',
      kind: 'waiting-input',
    });

    const row = w.rows.get('T-wait')!;
    expect(row.status).toBe('in_progress'); // 既有语义：等待角标由 kv 驱动
    expect(w.progress.get('hub-wait-1')?.waiting).toBe(true);
  });
});

describe('P1 降级守卫 — worker ensureRow 落 in 戳（spec §14）', () => {
  it('3a. 收委派建行 → delegation_role=in + auto_accept=1', () => {
    const w = makeSyncWorld();
    const record: DelegationRecord = {
      taskId: 'hub-in-1',
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      workspaceName: 'dev-ws',
      title: '承接外派任务',
      byNode: 'node-leader',
      state: 'running',
      createdAt: NOW,
      updatedAt: NOW,
    };
    const store: HubDelegationStore = {
      get: () => null,
      upsert: () => undefined,
      updateState: () => undefined,
      list: () => [],
    };
    createDelegationSync(w.ports).wrapWorkerStore(store).upsert(record);

    const row = [...w.rows.values()].find((r) => r.delegationId === 'hub-in-1')!;
    expect(row).toBeDefined();
    expect(row.delegationRole).toBe('in');
    expect(row.autoAccept).toBe(true);
  });
});

// ── 第 4 组：executor 本地过滤 out 行（spec §5.1 不变量 7；真 DB） ──────────

function seedAgentMember(instanceId: string): void {
  getDb()
    .prepare(
      `INSERT INTO agent_definitions (id, slug, name, version, system_prompt, model_name) VALUES ('def1', 'c', 'C', '1', 'p', 'm')`,
    )
    .run();
  getDb()
    .prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id) VALUES (?, 'ws1', 'def1', ?)`,
    )
    .run(instanceId, `@${instanceId}:s`);
}

function mkExecutor(max: number, kickoff: ExecutorDeps['sendKickoff']): TaskExecutor {
  const ex = new TaskExecutor();
  ex.init({ sendKickoff: kickoff, getGlobalMax: () => max });
  return ex;
}

describe('P1 降级守卫 — executor 放行过滤 out 行（spec §5.1 不变量 7）', () => {
  it('4a. out+assigned（高优先级）不被本地放行；local+assigned 正常放行', async () => {
    seedAgentMember('inst1');
    // 目标合法的 out 行（priority 10——若无过滤必被首选放行）
    const out = insertTask({
      workspaceId: 'ws1',
      title: '外派打回行',
      creatorUserId: 'owner',
      status: 'assigned',
      priority: 10,
      assigneeAgentId: 'inst1',
      routing: { mode: 'group', groupId: 'g1' },
    });
    updateTask(out.id, { delegationRole: 'out', autoAccept: true });
    const local = insertTask({
      workspaceId: 'ws1',
      title: '本地排队行',
      creatorUserId: 'owner',
      status: 'assigned',
      priority: 1,
      assigneeAgentId: 'inst1',
    });

    const kickoff = vi.fn().mockResolvedValue(undefined);
    await mkExecutor(2, kickoff).admitOnce();

    expect(getTask(out.id)!.status).toBe('assigned'); // 外派行本地不拉起
    expect(getTask(local.id)!.status).toBe('in_progress'); // 本地行照常放行
    expect(kickoff).toHaveBeenCalledTimes(1);
    expect(kickoff.mock.calls[0]![0].taskId).toBe(local.id);
  });

  it('4b. 仅 out 行在场 → admitOnce 零放行（kickoff 零调用，行保持 assigned）', async () => {
    seedAgentMember('inst1');
    const out = insertTask({
      workspaceId: 'ws1',
      title: '孤立外派行',
      creatorUserId: 'owner',
      status: 'assigned',
      priority: 10,
      assigneeAgentId: 'inst1',
      routing: { mode: 'node', groupId: 'g1', targetNodeId: 'node-a' },
    });
    updateTask(out.id, { delegationRole: 'out' });

    const kickoff = vi.fn().mockResolvedValue(undefined);
    await mkExecutor(3, kickoff).admitOnce();

    expect(getTask(out.id)!.status).toBe('assigned');
    expect(kickoff).not.toHaveBeenCalled();
  });

  it('4c. 边界：delegation_role=in 的 assigned 行不在过滤面（仅 out 被滤）', async () => {
    seedAgentMember('inst1');
    const inRow = insertTask({
      workspaceId: 'ws1',
      title: '承接行',
      creatorUserId: 'owner',
      status: 'assigned',
      priority: 10,
      assigneeAgentId: 'inst1',
    });
    updateTask(inRow.id, { delegationRole: 'in', autoAccept: true });

    const kickoff = vi.fn().mockResolvedValue(undefined);
    await mkExecutor(1, kickoff).admitOnce();

    // in 行的执行由 delegation-runner 链驱动是否放行属既有语义——本用例只锁
    // 过滤子句的精确性：out 专属，不误伤 in
    expect(getTask(inRow.id)!.status).toBe('in_progress');
  });
});
