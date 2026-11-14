// electron/tests/task/p1-degradation-guard.test.ts
//
// S8 版本门四象限矩阵（spec 2026-11-13-task-human-loop-lifecycle §8.5——改写自
// P1 降级守卫回归锁）：双端 protoVer ≥1.11 → 跨节点两段式（dispatch 不设
// auto_accept；worker 承接行不强制；done 拍降级为终局对账兜底 + warn）；任一
// 侧 <1.11 或未知 → P1 降级守卫原样（auto_accept=1 强制 + done 单方完成）。
// 六组锁：
//   0. 版本门函数全组合（hub {1.10,1.11,未知} × worker {1.10,1.11,未知}）
//   1. dispatch-submit 行戳按象限（真 DB 落行断言；网络边界 fake——生产同形
//      dispatch-ports.ts 接线）
//   1'. retryDispatch 重派行戳按象限（版本源缺席=旧接线 → P1；bothModern →
//       与首派同门，重派不把两段式打回 auto_accept）
//   2. delegation-sync done 拍按象限（象限判据=行戳：out 且未强制 auto_accept
//       即两段式派发行 → completed 直写不改 + warn 疑似降级回退）
//   3. worker ensureRow 按象限（worker 侧以 hub 版本单边判定——spec §8.5 裁定）
//   4. executor admitOnce 跳过 delegation_role='out' 的 assigned 行（与象限
//      无关的判向过滤，原样保留）
// task:update 剥 status 用例已在 tests/task/ipc-handlers.test.ts（minor-11 三
// 用例）覆盖，此处不重复。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, updateTask } from '../../src/main/storage/tasks/repo';
import { logger } from '../../src/main/logger';
import {
  submitRoutedTask,
  twoPhaseDelegationActive,
  workerTwoPhaseActive,
} from '../../src/main/hub/dispatch-submit';
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

// ── 第 0 组：版本门函数四象限全组合（纯函数） ────────────────────────────────

describe('S8 版本门函数 — 四象限全组合（spec §8.5）', () => {
  // hub {1.10.0, 1.11.0, null} × worker {1.10.0, 1.11.0, undefined} 九宫格——
  // 仅双 1.11 启用两段式；未知（null/undefined）与异形一律保守降级
  const hubs: Array<[string, string | null]> = [
    ['1.10.0', '1.10.0'],
    ['1.11.0', '1.11.0'],
    ['未知', null],
  ];
  const workers: Array<[string, string | undefined]> = [
    ['1.10.0', '1.10.0'],
    ['1.11.0', '1.11.0'],
    ['未知', undefined],
  ];
  for (const [hubLabel, hubVer] of hubs) {
    for (const [workerLabel, workerVer] of workers) {
      const bothModern = hubVer === '1.11.0' && workerVer === '1.11.0';
      it(`hub ${hubLabel} × worker ${workerLabel} → ${bothModern ? '两段式' : 'P1 降级'}`, () => {
        expect(twoPhaseDelegationActive(hubVer, workerVer)).toBe(bothModern);
      });
    }
  }

  it('patch 位不参与判定：hub 1.11.3 × worker 1.11.1 → 两段式；异形版本串视为未知', () => {
    expect(twoPhaseDelegationActive('1.11.3', '1.11.1')).toBe(true);
    expect(twoPhaseDelegationActive('1.11.0', 'x.y.z')).toBe(false);
  });

  it('workerTwoPhaseActive：worker 侧以 hub 版本单边判定（≥1.11 true；<1.11/null/异形 false）', () => {
    expect(workerTwoPhaseActive('1.11.0')).toBe(true);
    expect(workerTwoPhaseActive('1.12.0')).toBe(true);
    expect(workerTwoPhaseActive('1.10.9')).toBe(false);
    expect(workerTwoPhaseActive(null)).toBe(false);
    expect(workerTwoPhaseActive('garbage')).toBe(false);
  });
});

// ── 第 1 组：dispatch-submit 行戳按象限（真 DB） ─────────────────────────────

/** 生产同形端口（dispatch-ports.ts）：网络边界 fake，落库走真 insertTask/updateTask */
function productionShapedPorts(opts?: {
  delegateError?: Error;
  online?: boolean;
  delegateId?: string;
  hubProtoVer?: string | null;
  workerProtoVer?: string;
}) {
  return {
    listGroups: vi.fn().mockResolvedValue([
      {
        groupId: 'g1',
        groupName: 'dev-team',
        members: [
          {
            nodeId: 'node-a',
            name: 'office-mac',
            online: opts?.online ?? true,
            ...(opts?.workerProtoVer !== undefined ? { protoVer: opts.workerProtoVer } : {}),
          },
        ],
      },
    ]),
    hubProtoVer: vi.fn().mockReturnValue(opts?.hubProtoVer === undefined ? '1.9.0' : opts.hubProtoVer),
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
    // 生产同形（dispatch-ports.ts）：行戳随 delegation_id/routing 一并落行
    updateDelegationLink: vi.fn().mockImplementation(
      (
        taskId: string,
        delegationId: string,
        routing: TaskRouting,
        delegationStamp: { delegationRole: 'out'; autoAccept?: true },
      ) => {
        updateTask(taskId, { delegationId, routing, ...delegationStamp });
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

describe('S8 版本门 — dispatch-submit 行戳按象限（spec §8.5）', () => {
  it('1a. <1.11 象限（hub 1.10 × worker 1.10）→ out + auto_accept=1 + delegation_id 回写（P1 降级守卫原样）', async () => {
    const ports = productionShapedPorts({ hubProtoVer: '1.10.0', workerProtoVer: '1.10.0' });
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

  it('1a-2. hub 1.11 × worker 版本未知（离线/旧节点不带 protoVer）→ 强制 auto_accept（保守降级）', async () => {
    const ports = productionShapedPorts({ hubProtoVer: '1.11.0' });
    const result = await submitRoutedTask(
      routedInput({ mode: 'node', groupId: 'g1', targetNodeId: 'node-a' }),
      ports,
    );

    const row = getTask(result.task.id)!;
    expect(row.delegationRole).toBe('out');
    expect(row.autoAccept).toBe(true);
  });

  it('1a-3. hub 未知 × worker 1.11 → 强制 auto_accept（hub 拖后腿）', async () => {
    const ports = productionShapedPorts({ hubProtoVer: null, workerProtoVer: '1.11.0' });
    const result = await submitRoutedTask(
      routedInput({ mode: 'node', groupId: 'g1', targetNodeId: 'node-a' }),
      ports,
    );

    const row = getTask(result.task.id)!;
    expect(row.delegationRole).toBe('out');
    expect(row.autoAccept).toBe(true);
  });

  it('1a-4. hub 1.11 × worker 1.10 → 强制 auto_accept（worker 拖后腿）', async () => {
    const ports = productionShapedPorts({ hubProtoVer: '1.11.0', workerProtoVer: '1.10.0' });
    const result = await submitRoutedTask(
      routedInput({ mode: 'node', groupId: 'g1', targetNodeId: 'node-a' }),
      ports,
    );

    const row = getTask(result.task.id)!;
    expect(row.delegationRole).toBe('out');
    expect(row.autoAccept).toBe(true);
  });

  it('1a-5. bothModern（hub 1.11 × worker 1.11）→ out 恒戳 + auto_accept 不设（两段式，验收用户可配）', async () => {
    const ports = productionShapedPorts({ hubProtoVer: '1.11.0', workerProtoVer: '1.11.0' });
    const result = await submitRoutedTask(
      routedInput({ mode: 'node', groupId: 'g1', targetNodeId: 'node-a' }),
      ports,
    );

    expect(result.dispatched).toBe(true);
    const row = getTask(result.task.id)!;
    expect(row.delegationId).toBe('dl-guard-1');
    expect(row.delegationRole).toBe('out'); // 判向单源恒戳
    expect(row.autoAccept).toBe(false); // 不强制——submitted→验收两段式
  });

  it('1b. local 模式创建零 hub 交互 → 行不戳（delegationRole 保持 null）', async () => {
    const ports = productionShapedPorts({ hubProtoVer: '1.11.0', workerProtoVer: '1.11.0' });
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

// ── 第 1' 组：retryDispatch 重派行戳按象限 ───────────────────────────────────

function seedFailedDispatchRow(): string {
  // 首派失败（瞬断）留待处理→失败的行：无 delegation_id 也无 delegation_role
  const row = insertTask({
    workspaceId: 'ws1',
    title: '重派任务',
    creatorUserId: 'owner',
    status: 'failed',
    errorMessage: 'node_offline',
    routing: { mode: 'node', groupId: 'g1', targetNodeId: 'node-a' },
  });
  return row.id;
}

describe('S8 版本门 — retryDispatch 重派行戳按象限', () => {
  it("1d. 版本源缺席（旧接线）→ out + auto_accept=1（P1 默认象限）", async () => {
    const taskId = seedFailedDispatchRow();
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
    const result = await retryDispatch(taskId, ports);

    expect(result.dispatched).toBe(true);
    const after = getTask(taskId)!;
    expect(after.delegationId).toBe('dl-guard-new');
    expect(after.delegationRole).toBe('out');
    expect(after.autoAccept).toBe(true);
  });

  it('1d-2. bothModern（hub 1.11 × worker 1.11）→ out 恒戳 + auto_accept 不设（与首派同门，重派不倒退两段式）', async () => {
    const taskId = seedFailedDispatchRow();
    const ports = {
      getTask: (id: string) => getTask(id),
      workspaceNameOf: () => 'ws-main',
      resolveTarget: vi.fn().mockResolvedValue('node-b'),
      getTeamSnapshot: vi.fn().mockReturnValue(null),
      delegate: vi.fn().mockResolvedValue({ taskId: 'dl-guard-new' }),
      isPeerGroup: vi.fn().mockResolvedValue(false),
      hubProtoVer: () => '1.11.0',
      workerProtoVerOf: vi.fn().mockResolvedValue('1.11.0'),
      updateTask: (id: string, patch: Partial<TaskRow>) => updateTask(id, patch),
      now: () => NOW,
    };
    const result = await retryDispatch(taskId, ports);

    expect(result.dispatched).toBe(true);
    expect(ports.workerProtoVerOf).toHaveBeenCalledWith('g1', 'node-b');
    const after = getTask(taskId)!;
    expect(after.delegationRole).toBe('out');
    expect(after.autoAccept).toBe(false);
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

function makeSyncWorld(hubProtoVer?: string | null): {
  rows: Map<string, TaskRow>;
  progress: Map<string, DelegationProgressEntry>;
  ports: DelegationSyncPorts;
} {
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
    ...(hubProtoVer !== undefined ? { hubProtoVer: () => hubProtoVer } : {}),
    now: () => NOW,
  };
  return { rows, progress, ports };
}

describe('S8 版本门 — done 拍按象限（行戳判据；终局兜底不改）', () => {
  it('2a. P1 行（out + auto_accept=1）→ 直接 completed + accepted_at 同刻，无告警', () => {
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
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    createDelegationSync(w.ports).handleTerminal('done', 'hub-done-1');
    const warnCalls = warnSpy.mock.calls;
    warnSpy.mockRestore();

    const row = w.rows.get('T-out')!;
    expect(row.status).toBe('completed');
    expect(row.completedAt).toBe(NOW);
    expect(row.acceptedAt).toBe(NOW);
    expect(row.submittedAt).toBeNull(); // 旧单方语义：不经 submitted
    expect(warnCalls).toHaveLength(0);
  });

  it('2a-2. 两段式行（out 未强制 auto_accept）→ completed 直写照常（终局兜底）+ warn 疑似降级回退', () => {
    const w = makeSyncWorld();
    w.rows.set(
      'T-out2',
      mkRow({
        id: 'T-out2',
        title: '两段式外派行',
        status: 'in_progress',
        startedAt: 111,
        delegationId: 'hub-done-2',
        delegationRole: 'out',
        autoAccept: false,
      }),
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    createDelegationSync(w.ports).handleTerminal('done', 'hub-done-2');
    const warnCalls = warnSpy.mock.calls;
    warnSpy.mockRestore();

    const row = w.rows.get('T-out2')!;
    expect(row.status).toBe('completed'); // 终局兜底不改：done 拍照常收口
    expect(row.completedAt).toBe(NOW);
    expect(row.acceptedAt).toBe(NOW);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]![0]).toBe('1.11 两段式链路收到 done 拍——疑似降级回退（终局兜底照常收口）');
    expect(warnCalls[0]![1]).toEqual({ taskId: 'T-out2', delegationId: 'hub-done-2' });
  });

  it('2a-3. 手工委派行（无 out 戳，auto_accept 未设）→ completed 直写，不误告警', () => {
    const w = makeSyncWorld();
    w.rows.set(
      'T-manual',
      mkRow({
        id: 'T-manual',
        title: '手工委派行',
        status: 'in_progress',
        startedAt: 111,
        delegationId: 'hub-done-3',
      }),
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    createDelegationSync(w.ports).handleTerminal('done', 'hub-done-3');
    const warnCalls = warnSpy.mock.calls;
    warnSpy.mockRestore();

    const row = w.rows.get('T-manual')!;
    expect(row.status).toBe('completed');
    expect(warnCalls).toHaveLength(0);
  });

  it('2a-4. S8 Important-1（S9 清偿）：两段式行已终态（submitted→验收已收口 / done 重投）→ 不误报降级回退', () => {
    const w = makeSyncWorld();
    w.rows.set(
      'T-done-late',
      mkRow({
        id: 'T-done-late',
        title: '两段式已收口行',
        status: 'completed',
        startedAt: 111,
        completedAt: 222,
        delegationId: 'hub-done-4',
        delegationRole: 'out',
        autoAccept: false,
      }),
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    createDelegationSync(w.ports).handleTerminal('done', 'hub-done-4');
    const warnCalls = warnSpy.mock.calls;
    warnSpy.mockRestore();

    const row = w.rows.get('T-done-late')!;
    expect(row.status).toBe('completed');
    expect(row.completedAt).toBe(222); // 同态零写：首写 completedAt 不重盖（T12 Low-1 语义）
    expect(warnCalls).toHaveLength(0); // 滞后对账/重投 ≠ 降级回退——守卫不告警
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

describe('S8 版本门 — worker ensureRow 按象限（hub 版本单边判定）', () => {
  function upsertRunningRecord(w: ReturnType<typeof makeSyncWorld>): void {
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
  }

  it('3a. hub <1.11（1.10.0）→ delegation_role=in + auto_accept=1（P1 降级守卫原样）', () => {
    const w = makeSyncWorld('1.10.0');
    upsertRunningRecord(w);

    const row = [...w.rows.values()].find((r) => r.delegationId === 'hub-in-1')!;
    expect(row).toBeDefined();
    expect(row.delegationRole).toBe('in');
    expect(row.autoAccept).toBe(true);
  });

  it('3a-2. hub 版本源缺席（旧接线）→ in + auto_accept=1', () => {
    const w = makeSyncWorld();
    upsertRunningRecord(w);

    const row = [...w.rows.values()].find((r) => r.delegationId === 'hub-in-1')!;
    expect(row.delegationRole).toBe('in');
    expect(row.autoAccept).toBe(true);
  });

  it('3a-3. hub ≥1.11 → in 恒戳 + auto_accept 不设（承接行走 submitted→远端验收）', () => {
    const w = makeSyncWorld('1.11.0');
    upsertRunningRecord(w);

    const row = [...w.rows.values()].find((r) => r.delegationId === 'hub-in-1')!;
    expect(row.delegationRole).toBe('in');
    expect(row.autoAccept).toBe(false);
  });
});

// ── 第 4 组：executor 本地过滤 out 行（§5.1 不变量 7，与象限无关；真 DB） ────

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

describe('executor 放行过滤 out 行（§5.1 不变量 7——判向过滤与象限无关）', () => {
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
