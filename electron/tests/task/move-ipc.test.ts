// electron/tests/task/move-ipc.test.ts
//
// 看板重构 Task 6 回归锁:task:move / task:archive / task:unarchive 三条新
// IPC 通道 + task:list 的 archived 三态透传。
// move 选动作语义由 move.test.ts 锁(executeMove 层);本文件锁 IPC 注册面:
// 通道存在、参数透传、返回 TaskRow、归档域校验(仅终态可归档)、写通道成功
// 后触发 P2P 快照广播(与既有四写通道惯例对齐)。
//
// mock 边界(momo-test-rules):只 mock electron 边界(ipcMain.handle 注册),
// 用 hoisted Map 捕获 handler(照 ipc-handlers.test.ts 先例);状态机 / repo /
// move 全部真实运行;broadcast / notifyExecutor 用模块 spy 断言触发但不真跑。
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
import { insertTask, updateTask, transitionTaskStatus } from '../../src/main/storage/tasks/repo';
import type { TaskRow, TaskStatus } from '../../src/main/storage/tasks/repo';
import { registerTaskHandlers } from '../../src/main/task/ipc.handlers';
import * as taskBroadcastMod from '../../src/main/p2p/task-broadcast';

// 写通道成功后 fire-and-forget 广播——spy 模块导出(tsc→CJS 属性访问,spy 生效)
const broadcastSpy = vi.spyOn(taskBroadcastMod, 'broadcastLocalTaskSnapshot');

const WS = 'wsi';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-move-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/** 直插任务(draft/pending/assigned 直插即生产合法;派生态走 seedViaChain) */
const seed = (status: TaskStatus, extra: Partial<TaskRow> = {}) =>
  insertTask({ workspaceId: WS, title: 't', creatorUserId: 'owner', status, ...extra });

/** 经生产合法链 seed in_progress(momo-test-rules:派生态不直插,贴真实运行时) */
function seedInProgress(): TaskRow {
  const t = seed('assigned', { assigneeAgentId: 'i-1' });
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
  registerTaskHandlers();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
  broadcastSpy.mockClear();
});

describe('task:move IPC', () => {
  it('通道透传 executeMove 并返回 TaskRow(draft→assigned 列)', async () => {
    const t = seed('draft', { assigneeAgentId: 'i' });
    const handler = handlers.get('task:move');
    expect(handler).toBeDefined();
    const row = (await handler!(null, t.id, { column: 'assigned', groupId: null })) as TaskRow;
    expect(row.status).toBe('assigned');
    expect(row.id).toBe(t.id);
  });

  it('move 成功后触发 P2P 快照广播(与既有写通道惯例对齐)', async () => {
    const t = seed('draft', { assigneeAgentId: 'i' });
    const handler = handlers.get('task:move')!;
    await handler(null, t.id, { column: 'assigned', groupId: null });
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
  });
});

describe('task:archive IPC', () => {
  it('终态任务归档成功置 archived_at', async () => {
    const done = seed('completed');
    const handler = handlers.get('task:archive')!;
    const row = (await handler(null, done.id)) as TaskRow;
    expect(row.archivedAt).not.toBeNull();
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
  });

  it('非终态任务归档拒绝(Review Focus 边界)', async () => {
    const run = seedInProgress();
    const handler = handlers.get('task:archive')!;
    await expect(handler(null, run.id)).rejects.toThrow('终态');
  });

  it('不存在的任务拒绝(错误路径)', async () => {
    const handler = handlers.get('task:archive')!;
    await expect(handler(null, 'no-such-id')).rejects.toThrow('不存在');
  });
});

describe('task:unarchive IPC', () => {
  it('清空 archived_at 并广播', async () => {
    const t = seed('completed');
    updateTask(t.id, { archivedAt: 1 });
    const handler = handlers.get('task:unarchive')!;
    const row = (await handler(null, t.id)) as TaskRow;
    expect(row.archivedAt).toBeNull();
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
  });

  it('不存在的任务拒绝(updateTask 单点校验,错误路径)', async () => {
    const handler = handlers.get('task:unarchive')!;
    await expect(handler(null, 'no-such-id')).rejects.toThrow('不存在');
  });
});

describe('task:list archived 三态透传', () => {
  it("archived:'only' 只回归档行;'all' 全回;缺省排除归档行", async () => {
    const active = seed('draft');
    const done = seed('completed');
    updateTask(done.id, { archivedAt: Date.now() });

    const listHandler = handlers.get('task:list')!;
    const only = (await listHandler(null, { workspaceId: WS, archived: 'only' })) as TaskRow[];
    expect(only.map((r) => r.id)).toEqual([done.id]);
    const all = (await listHandler(null, { workspaceId: WS, archived: 'all' })) as TaskRow[];
    expect(new Set(all.map((r) => r.id))).toEqual(new Set([active.id, done.id]));
    const excluded = (await listHandler(null, { workspaceId: WS })) as TaskRow[];
    expect(excluded.map((r) => r.id)).toEqual([active.id]);
  });
});
