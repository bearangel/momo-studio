// electron/tests/task/groups-ipc.test.ts
//
// 看板重构 Task 7 回归锁:taskGroup:* 六通道 IPC 注册面。
// CRUD / 级联事务语义由 task-groups-repo.test.ts 锁(repo 层);本文件锁:
// 通道存在、参数透传、archive 返回级联计数 + cancelledIds 逐个补 abort
// (进程级副作用与 DB 事务分离)、abort 失败吞错只 warn 不阻断归档、
// unarchive 后组回到默认 list。
//
// mock 边界(momo-test-rules):只 mock electron 边界(ipcMain.handle 注册,
// hoisted Map 捕获,照 move-ipc.test.ts 先例);repo/状态机真实运行;
// broadcast / abortTaskExecution / logger.warn 用模块 spy 断言触发。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface IpcHandler {
  (event: unknown, ...args: unknown[]): Promise<unknown> | unknown;
}

/** 用 hoisted 状态捕获 ipcMain.handle 注册的 handler 集合 */
const handlers = vi.hoisted(() => new Map<string, IpcHandler>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: IpcHandler): void => {
      handlers.set(channel, fn);
    },
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createGroup } from '../../src/main/storage/task-groups/repo';
import type { GroupRow } from '../../src/main/storage/task-groups/repo';
import { insertTask, transitionTaskStatus, listTasks } from '../../src/main/storage/tasks/repo';
import type { TaskRow, TaskStatus } from '../../src/main/storage/tasks/repo';
import { registerTaskGroupHandlers } from '../../src/main/task/groups.ipc.handlers';
import * as taskBroadcastMod from '../../src/main/p2p/task-broadcast';
import * as lifecycleMod from '../../src/main/task/lifecycle';
import * as loggerMod from '../../src/main/logger';

// archive 成功后的 fire-and-forget 广播 + 级联 abort——spy 模块导出
// (tsc→CJS 属性访问,spy 生效,照 move-ipc.test.ts 先例)
const broadcastSpy = vi.spyOn(taskBroadcastMod, 'broadcastLocalTaskSnapshot');
const abortSpy = vi.spyOn(lifecycleMod, 'abortTaskExecution');
const loggerWarnSpy = vi.spyOn(loggerMod.logger, 'warn');

const WS = 'wsg';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-groups-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/** 直插任务(draft/pending/assigned/completed 直插即生产合法;派生态走 seedInProgress) */
const seed = (status: TaskStatus, extra: Partial<TaskRow> = {}) =>
  insertTask({ workspaceId: WS, title: 't', creatorUserId: 'owner', status, ...extra });

/** 经生产合法链 seed in_progress(momo-test-rules:派生态不直插,贴真实运行时) */
function seedInProgress(extra: Partial<TaskRow> = {}): TaskRow {
  const t = seed('assigned', { assigneeAgentId: 'i-1', ...extra });
  return transitionTaskStatus(t.id, 'in_progress', { executionSessionId: 'sess-1' });
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run(WS, 'Test', '/tmp', 'owner');
  handlers.clear();
  registerTaskGroupHandlers();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
  broadcastSpy.mockClear();
  abortSpy.mockClear();
  loggerWarnSpy.mockClear();
});

describe('taskGroup:create IPC', () => {
  it('建组返回 GroupRow(G-<seq> id,默认活跃)', async () => {
    const handler = handlers.get('taskGroup:create');
    expect(handler).toBeDefined();
    const g = (await handler!(null, { workspaceId: WS, name: 'v2.1.0' })) as GroupRow;
    expect(g.id).toMatch(/^G-\d{3,}$/);
    expect(g.name).toBe('v2.1.0');
    expect(g.archivedAt).toBeNull();
  });
});

describe('taskGroup:list IPC', () => {
  it('默认 exclude 活跃组;only 只回归档组;all 全回', async () => {
    const keep = createGroup({ workspaceId: WS, name: 'keep' });
    const gone = createGroup({ workspaceId: WS, name: 'gone' });
    await handlers.get('taskGroup:archive')!(null, gone.id);

    const listHandler = handlers.get('taskGroup:list')!;
    const excluded = (await listHandler(null, WS)) as GroupRow[];
    expect(excluded.map((g) => g.id)).toEqual([keep.id]);
    const only = (await listHandler(null, WS, { archived: 'only' })) as GroupRow[];
    expect(only.map((g) => g.id)).toEqual([gone.id]);
    const all = (await listHandler(null, WS, { archived: 'all' })) as GroupRow[];
    expect(new Set(all.map((g) => g.id))).toEqual(new Set([keep.id, gone.id]));
  });

  it('unarchive 后组重新回到默认 exclude 列表', async () => {
    const g = createGroup({ workspaceId: WS, name: 'back' });
    await handlers.get('taskGroup:archive')!(null, g.id);
    await handlers.get('taskGroup:unarchive')!(null, g.id);
    const excluded = (await handlers.get('taskGroup:list')!(null, WS)) as GroupRow[];
    expect(excluded.map((x) => x.id)).toEqual([g.id]);
  });
});

describe('taskGroup:update IPC', () => {
  it('改名透传并返回更新行', async () => {
    const g = createGroup({ workspaceId: WS, name: 'old' });
    const row = (await handlers.get('taskGroup:update')!(null, g.id, { name: 'new' })) as GroupRow;
    expect(row.name).toBe('new');
  });
});

describe('taskGroup:reorder IPC', () => {
  it('按入参顺序重写 position(list 顺序跟随)', async () => {
    const a = createGroup({ workspaceId: WS, name: 'a' });
    const b = createGroup({ workspaceId: WS, name: 'b' });
    await handlers.get('taskGroup:reorder')!(null, [b.id, a.id]);
    const list = (await handlers.get('taskGroup:list')!(null, WS)) as GroupRow[];
    expect(list.map((g) => g.id)).toEqual([b.id, a.id]);
  });
});

describe('taskGroup:archive IPC', () => {
  it('返回级联计数 + 对 cancelledIds 逐个补 abort + 广播快照', async () => {
    const g = createGroup({ workspaceId: WS, name: 'v' });
    const run = seedInProgress({ groupId: g.id });
    seed('completed', { groupId: g.id });

    const res = (await handlers.get('taskGroup:archive')!(null, g.id)) as {
      cancelledIds: string[];
      archivedCount: number;
    };
    expect(res).toEqual({ cancelledIds: [run.id], archivedCount: 2 });
    // 级联 cancel 的 in_progress 来源停运行时:恰好一次 abort,目标精确
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledWith(run.id);
    // 归档改变 task:list 默认可见性 → 触发 P2P 快照广播(与既有写通道惯例对齐)
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
  });

  it('abort 失败吞错只 warn——不阻断归档结果', async () => {
    const g = createGroup({ workspaceId: WS, name: 'v' });
    seedInProgress({ groupId: g.id });
    abortSpy.mockImplementationOnce(() => {
      throw new Error('运行时已销毁');
    });

    const res = (await handlers.get('taskGroup:archive')!(null, g.id)) as {
      cancelledIds: string[];
      archivedCount: number;
    };
    expect(res.archivedCount).toBe(1);
    expect(loggerWarnSpy).toHaveBeenCalled();
  });

  it('已归档组幂等:零值返回,不再 abort', async () => {
    const g = createGroup({ workspaceId: WS, name: 'v' });
    await handlers.get('taskGroup:archive')!(null, g.id);
    const res = (await handlers.get('taskGroup:archive')!(null, g.id)) as {
      cancelledIds: string[];
      archivedCount: number;
    };
    expect(res).toEqual({ cancelledIds: [], archivedCount: 0 });
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it('不存在的组拒绝(错误路径)', async () => {
    await expect(handlers.get('taskGroup:archive')!(null, 'no-such-id')).rejects.toThrow('不存在');
  });
});

describe('taskGroup:unarchive IPC', () => {
  it('解档返回 archivedAt=null 的组行', async () => {
    const g = createGroup({ workspaceId: WS, name: 'v' });
    await handlers.get('taskGroup:archive')!(null, g.id);
    const row = (await handlers.get('taskGroup:unarchive')!(null, g.id)) as GroupRow;
    expect(row.archivedAt).toBeNull();
  });

  it('经通道解档后组内归档任务一并回归默认列表', async () => {
    const g = createGroup({ workspaceId: WS, name: 'v' });
    const run = seedInProgress({ groupId: g.id });
    const done = seed('completed', { groupId: g.id });
    await handlers.get('taskGroup:archive')!(null, g.id);
    expect(listTasks({ workspaceId: WS })).toHaveLength(0);

    await handlers.get('taskGroup:unarchive')!(null, g.id);

    expect(listTasks({ workspaceId: WS }).map((t) => t.id).sort()).toEqual(
      [run.id, done.id].sort(),
    );
  });

  it('不存在的组拒绝(错误路径)', async () => {
    await expect(handlers.get('taskGroup:unarchive')!(null, 'no-such-id')).rejects.toThrow(
      '不存在',
    );
  });
});

describe('taskGroup:delete IPC', () => {
  it('转移到目标组并删除组行,返回 movedCount + 广播快照', async () => {
    const victim = createGroup({ workspaceId: WS, name: '待删' });
    const keeper = createGroup({ workspaceId: WS, name: '承接' });
    const t1 = seed('draft', { groupId: victim.id });
    seed('completed', { groupId: victim.id });

    const res = (await handlers.get('taskGroup:delete')!(null, victim.id, keeper.id)) as {
      movedCount: number;
    };

    expect(res).toEqual({ movedCount: 2 });
    expect(listTasks({ workspaceId: WS }).every((t) => t.groupId === keeper.id)).toBe(true);
    expect(listTasks({ workspaceId: WS }).map((t) => t.id)).toContain(t1.id);
    expect((await handlers.get('taskGroup:list')!(null, WS)) as GroupRow[]).toHaveLength(1);
    // 转移改变任务行 → 触发 P2P 快照广播(与既有写通道惯例对齐)
    expect(broadcastSpy).toHaveBeenCalled();
  });

  it('moveToGroupId=null 转移到未分组', async () => {
    const g = createGroup({ workspaceId: WS, name: '待删' });
    const t = seed('draft', { groupId: g.id });

    const res = (await handlers.get('taskGroup:delete')!(null, g.id, null)) as {
      movedCount: number;
    };

    expect(res.movedCount).toBe(1);
    expect(listTasks({ workspaceId: WS }).map((x) => x.id)).toEqual([t.id]);
    expect(listTasks({ workspaceId: WS })[0]?.groupId).toBeNull();
  });

  it('目标非法 / 组不存在拒绝(错误路径)', async () => {
    const g = createGroup({ workspaceId: WS, name: '待删' });
    await expect(handlers.get('taskGroup:delete')!(null, g.id, g.id)).rejects.toThrow('自身');
    await expect(handlers.get('taskGroup:delete')!(null, 'no-such-id', null)).rejects.toThrow(
      '不存在',
    );
  });
});
