// electron/tests/p2p/task-broadcast.test.ts
//
// 任务快照出站广播测试（P4 Task 2）。
//
// 覆盖：
//   ① 字段裁剪——TaskRow 全量 25 字段 → TaskSnapshot 7 字段子集 + nodeId/nodeName/takenAt
//   ② 空任务——listTasks({}) 为空时仍广播空快照（tasks: []）
//   ③ P2P 未启用——deps 未装配时静默 no-op（不抛、不查库）；广播失败仅记日志不抛
//   ④ 写路径接线——task:create/transition/cancel/start 成功后 fire-and-forget 触发；
//      读通道（task:list）不触发；scheduler checkOnce 有升级则整批合并广播一次
//   ⑤ initP2p/stopP2p 装配——init 后 deps 可用（身份来自 identity 模块），stop 后回 no-op；
//      facade（p2p/index.ts）再导出同一函数
//
// 模式：与 tests/im/session.ipc.handlers.test.ts 一致——vi.hoisted + vi.mock 捕获
// ipcMain.handle 注册表（capture 真实注册的 handler）；依赖模块全 mock，
// 不依赖真实 DB / 网络 / 文件 IO。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ipcHandlers, taskRepoMocks, starterMocks, conflictMocks, dbAll, dbRun } = vi.hoisted(() => ({
  // ipcMain.handle 注册表——capture 真实注册的 handler 后按通道调用
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  // storage/tasks/repo 桩（ipc.handlers 与 task-broadcast 共用同一 mock 实例）
  taskRepoMocks: {
    insertTask: vi.fn(),
    listTasks: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    transitionTaskStatus: vi.fn(),
  },
  // task/starter 桩
  starterMocks: {
    startTask: vi.fn(),
  },
  // conflict-resolver / conflict-executor 桩（两模块各取所需，共用一个对象）
  conflictMocks: {
    resolveConflict: vi.fn(),
    executeConflictResolution: vi.fn(),
  },
  // scheduler.checkOnce 走原生 SQL（不走 repo）——mock getDb 的 prepare().all/run
  dbAll: vi.fn(),
  dbRun: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/main/storage/tasks/repo', () => taskRepoMocks);
vi.mock('../../src/main/task/starter', () => starterMocks);
vi.mock('../../src/main/task/conflict-resolver', () => conflictMocks);
vi.mock('../../src/main/task/conflict-executor', () => conflictMocks);

vi.mock('../../src/main/storage/db', () => ({
  getDb: () => ({
    prepare: (_sql: string) => ({ all: dbAll, run: dbRun }),
  }),
}));

// ⑤ initP2p 装配测试需要的传输层 / 身份桩——重模块全 mock，避免 mDNS / 文件 IO
vi.mock('../../src/main/p2p/router', () => ({
  Router: class {
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    onIncoming = vi.fn(() => () => {});
    send = vi.fn(async () => {});
  },
}));
vi.mock('../../src/main/p2p/local-transport', () => ({
  LocalTransport: class {},
}));
vi.mock('../../src/main/p2p/lan-transport', () => ({
  LanTransport: class {},
}));
vi.mock('../../src/main/p2p/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/p2p/identity')>()),
  loadIdentity: vi.fn(() => ({
    nodeId: 'node-init',
    displayName: '初始化节点',
    publicKey: new Uint8Array(32),
  })),
  generateIdentity: vi.fn(),
  saveIdentity: vi.fn(),
}));
vi.mock('../../src/main/p2p/trust-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/p2p/trust-store')>()),
  listTrustedNodes: vi.fn(() => []),
  addTrustedNode: vi.fn(),
  removeTrustedNode: vi.fn(),
  isTrusted: vi.fn(() => false),
  getTrustedPublicKey: vi.fn(() => null),
  getTrustedBoxPublicKey: vi.fn(() => null),
}));
vi.mock('../../src/main/storage/messages/repo', () => ({
  insertMessage: vi.fn(),
}));

import {
  broadcastLocalTaskSnapshot,
  setTaskBroadcastDeps,
  clearTaskBroadcastDeps,
} from '../../src/main/p2p/task-broadcast';
import {
  initP2p,
  stopP2p,
  broadcastLocalTaskSnapshot as facadeBroadcast,
} from '../../src/main/p2p/index';
import { P2pSync } from '../../src/main/p2p/sync';
import { registerTaskHandlers } from '../../src/main/task/ipc.handlers';
import { TaskScheduler } from '../../src/main/task/scheduler';
import type { TaskRow } from '../../src/main/storage/tasks/repo';

/** 完整 TaskRow fixture——25 字段全填非默认值，验证快照裁剪只保留 7 字段子集 */
function makeFullTaskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'T-1',
    workspaceId: 'ws-1',
    title: '示例任务',
    description: '不在快照子集内的长描述字段',
    status: 'pending',
    sourceSessionId: 'sess-1',
    sourceMessageId: 'msg-1',
    creatorUserId: 'owner',
    executionSessionId: null,
    assigneeAgentId: 'agent-1',
    priority: 3,
    scheduledAt: 111,
    recurrenceRule: null,
    deadlineAt: 222,
    queuePosition: 9,
    runtimeInstanceId: 'rt-1',
    estimatedTokens: 999,
    actualTokens: 888,
    toolCallsUsed: 7,
    errorMessage: 'err',
    sourceNodeId: 'node-x',
    createdAt: 1000,
    updatedAt: 2000,
    startedAt: 3000,
    completedAt: 4000,
    ...overrides,
  };
}

/** 统一装配 deps（nodeId/nodeName 固定值，便于断言快照身份字段）；返回 sync 桩供断言 */
function useFakeSync() {
  const sync = { broadcastTaskSnapshot: vi.fn().mockResolvedValue(undefined) };
  setTaskBroadcastDeps({ sync, nodeId: 'node-a', nodeName: '节点A' });
  return sync;
}

beforeEach(() => {
  ipcHandlers.clear();
  Object.values(taskRepoMocks).forEach((m) => m.mockReset());
  taskRepoMocks.listTasks.mockReturnValue([]);
  starterMocks.startTask.mockReset();
  conflictMocks.resolveConflict.mockReset();
  conflictMocks.executeConflictResolution.mockReset();
  dbAll.mockReset();
  dbAll.mockReturnValue([]);
  dbRun.mockReset();
  clearTaskBroadcastDeps();
});

describe('broadcastLocalTaskSnapshot 快照构造', () => {
  it('① TaskRow 全量字段裁剪为 7 字段子集 + nodeId/nodeName/takenAt', async () => {
    const sync = useFakeSync();
    taskRepoMocks.listTasks.mockReturnValueOnce([
      makeFullTaskRow(),
      makeFullTaskRow({
        id: 'T-2',
        title: '第二条',
        status: 'in_progress',
        assigneeAgentId: null,
      }),
    ]);

    await broadcastLocalTaskSnapshot();

    expect(sync.broadcastTaskSnapshot).toHaveBeenCalledTimes(1);
    const snap = sync.broadcastTaskSnapshot.mock.calls[0][0];
    // toEqual 深比较——多一个字段（如 description）或少一个字段都会失败
    expect(snap.tasks[0]).toEqual({
      id: 'T-1',
      title: '示例任务',
      status: 'pending',
      assigneeAgentId: 'agent-1',
      priority: 3,
      createdAt: 1000,
      updatedAt: 2000,
    });
    expect(snap.tasks[1]).toEqual({
      id: 'T-2',
      title: '第二条',
      status: 'in_progress',
      assigneeAgentId: null,
      priority: 3,
      createdAt: 1000,
      updatedAt: 2000,
    });
    expect(snap.nodeId).toBe('node-a');
    expect(snap.nodeName).toBe('节点A');
    expect(typeof snap.takenAt).toBe('number');
    // 全量扫描——listTasks({}) 不带任何过滤
    expect(taskRepoMocks.listTasks).toHaveBeenCalledWith({});
  });

  it('② 无任务时仍广播空快照', async () => {
    const sync = useFakeSync();
    taskRepoMocks.listTasks.mockReturnValueOnce([]);

    await broadcastLocalTaskSnapshot();

    expect(sync.broadcastTaskSnapshot).toHaveBeenCalledTimes(1);
    expect(sync.broadcastTaskSnapshot.mock.calls[0][0]).toMatchObject({
      nodeId: 'node-a',
      nodeName: '节点A',
      tasks: [],
    });
  });

  it('③ P2P 未启用（deps 未装配）→ 静默 no-op：不抛错、不查库、不广播', async () => {
    await expect(broadcastLocalTaskSnapshot()).resolves.toBeUndefined();
    expect(taskRepoMocks.listTasks).not.toHaveBeenCalled();
  });

  it('③b 广播失败（sync 抛错）→ 吞错不抛（容错同 broadcastLocalMessage）', async () => {
    setTaskBroadcastDeps({
      sync: { broadcastTaskSnapshot: vi.fn().mockRejectedValue(new Error('net down')) },
      nodeId: 'node-a',
      nodeName: '节点A',
    });
    taskRepoMocks.listTasks.mockReturnValueOnce([]);

    await expect(broadcastLocalTaskSnapshot()).resolves.toBeUndefined();
  });
});

describe('task IPC 写路径触发接线', () => {
  beforeEach(() => {
    registerTaskHandlers();
  });

  it('④ task:create 成功后触发广播（全量重扫）', async () => {
    const sync = useFakeSync();
    taskRepoMocks.insertTask.mockReturnValueOnce(makeFullTaskRow());

    const created = await ipcHandlers.get('task:create')!({} as never, {
      workspaceId: 'ws-1',
      title: '新任务',
    });

    expect(created).toMatchObject({ id: 'T-1' });
    expect(taskRepoMocks.insertTask).toHaveBeenCalledTimes(1);
    // 写路径成功 → fire-and-forget 广播 + 全量扫描
    expect(sync.broadcastTaskSnapshot).toHaveBeenCalledTimes(1);
    expect(taskRepoMocks.listTasks).toHaveBeenCalledWith({});
  });

  it('④ task:transition 成功后触发广播', async () => {
    const sync = useFakeSync();
    taskRepoMocks.transitionTaskStatus.mockReturnValueOnce(
      makeFullTaskRow({ status: 'in_progress' }),
    );

    await ipcHandlers.get('task:transition')!({} as never, 'T-1', 'in_progress');

    expect(taskRepoMocks.transitionTaskStatus).toHaveBeenCalledWith(
      'T-1',
      'in_progress',
      undefined,
    );
    expect(sync.broadcastTaskSnapshot).toHaveBeenCalledTimes(1);
  });

  it('④ task:cancel 成功后触发广播', async () => {
    const sync = useFakeSync();

    await ipcHandlers.get('task:cancel')!({} as never, 'T-1');

    expect(taskRepoMocks.transitionTaskStatus).toHaveBeenCalledWith('T-1', 'cancelled');
    expect(sync.broadcastTaskSnapshot).toHaveBeenCalledTimes(1);
  });

  it('④ task:start 成功后触发广播', async () => {
    const sync = useFakeSync();
    starterMocks.startTask.mockResolvedValueOnce({
      task: makeFullTaskRow({ status: 'in_progress' }),
      executionSessionId: 'sess-9',
      createdNewRoom: true,
    });

    const res = await ipcHandlers.get('task:start')!({} as never, 'T-1');

    expect(res).toEqual({ executionSessionId: 'sess-9', createdNewRoom: true });
    expect(sync.broadcastTaskSnapshot).toHaveBeenCalledTimes(1);
  });

  // minor-11 回归锁：task:update 携带 status 时静默剥离，强制走 task:transition / task:cancel。
  // 旧实现直接调 updateTask(id, patch) 写入 status → 终端任务复活 / 非法状态机迁移
  // （终态 → in_progress 等）。新实现 hasOwnProperty 检查 + 移除 status 字段，
  // 其他字段照常落库；warn 日志帮助定位误用源头。
  it('minor-11：task:update 携带 status 时剥离——其他字段照常落库；status 走 task:transition', async () => {
    const sync = useFakeSync();

    await ipcHandlers.get('task:update')!(
      {} as never,
      'T-1',
      { title: '新标题', status: 'completed', priority: 5 },
    );

    // updateTask 调用收到的 patch 不含 status（剥离生效）
    expect(taskRepoMocks.updateTask).toHaveBeenCalledTimes(1);
    const call = taskRepoMocks.updateTask.mock.calls[0]!;
    expect(call[0]).toBe('T-1');
    expect(call[1]).not.toHaveProperty('status');
    expect(call[1]).toMatchObject({ title: '新标题', priority: 5 });
    // task:update 不是写通道（不触发快照广播）
    expect(sync.broadcastTaskSnapshot).not.toHaveBeenCalled();
  });

  it('minor-11：task:update 不带 status 时按原样透传给 repo', async () => {
    await ipcHandlers.get('task:update')!(
      {} as never,
      'T-1',
      { title: '改个标题' },
    );
    expect(taskRepoMocks.updateTask).toHaveBeenCalledWith('T-1', { title: '改个标题' });
  });

  it('④ 读通道（task:list）不触发广播', async () => {
    const sync = useFakeSync();

    await ipcHandlers.get('task:list')!({} as never, {});

    expect(sync.broadcastTaskSnapshot).not.toHaveBeenCalled();
  });
});

describe('scheduler 自动升级触发', () => {
  it('④ checkOnce 有 pending→assigned 升级 → 整批合并广播一次', () => {
    const sync = useFakeSync();
    dbAll.mockReturnValueOnce([
      { id: 'T-1', assignee_agent_id: 'inst-1' },
      { id: 'T-2', assignee_agent_id: 'inst-2' },
    ]);
    const scanPickup = vi.fn().mockResolvedValue(true);

    new TaskScheduler({ scanPickup }).checkOnce();

    expect(scanPickup).toHaveBeenCalledTimes(2);
    // 两条升级合并为一次全量快照广播（快照本身是全量扫描，无需逐条广播）
    expect(sync.broadcastTaskSnapshot).toHaveBeenCalledTimes(1);
  });

  it('④ 无到期任务 → 不广播', () => {
    const sync = useFakeSync();
    const scanPickup = vi.fn().mockResolvedValue(true);

    new TaskScheduler({ scanPickup }).checkOnce();

    expect(scanPickup).not.toHaveBeenCalled();
    expect(sync.broadcastTaskSnapshot).not.toHaveBeenCalled();
  });
});

describe('initP2p / stopP2p 装配（index.ts）', () => {
  it('⑤ init 后 deps 装配（身份来自 identity 模块）→ stop 后回到 no-op', async () => {
    const spy = vi
      .spyOn(P2pSync.prototype, 'broadcastTaskSnapshot')
      .mockResolvedValue(undefined);
    try {
      await initP2p();

      taskRepoMocks.listTasks.mockReturnValueOnce([]);
      await broadcastLocalTaskSnapshot();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({
        nodeId: 'node-init',
        nodeName: '初始化节点',
        tasks: [],
      });

      await stopP2p();
      taskRepoMocks.listTasks.mockClear();
      await broadcastLocalTaskSnapshot();
      // deps 已清空 → 静默 no-op（不再查库）
      expect(taskRepoMocks.listTasks).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('⑤ facade 再导出同一函数（p2p/index 与 task-broadcast 模块一致）', () => {
    expect(facadeBroadcast).toBe(broadcastLocalTaskSnapshot);
  });
});
