// electron/tests/task/ipc-handlers.test.ts
//
// minor-11 回归锁：task:update IPC 剥离 status 字段——状态变更必须走
// task:transition / task:cancel。旧实现 patch.status 直写绕开状态机，
// 可令 cancelled 任务被"复活"或非法迁移。
//
// mock 边界（momo-test-rules）：只 mock electron 边界（ipcMain.handle 注册）；
// 业务侧 updateTask / transitionTaskStatus / logger 全部真实运行。
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
import { insertTask, transitionTaskStatus, getTask } from '../../src/main/storage/tasks/repo';
import { registerTaskHandlers } from '../../src/main/task/ipc.handlers';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`,
    )
    .run('ws1', 'Test', '/tmp', '@owner:home');
  handlers.clear();
  registerTaskHandlers();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('task:update（minor-11）', () => {
  it('patch 含 status → 静默剥离，status 不变，其他字段仍生效', async () => {
    const t = insertTask({ workspaceId: 'ws1', title: 'orig', creatorUserId: '@owner:home' });

    const handler = handlers.get('task:update');
    expect(handler).toBeDefined();
    await handler!(null, t.id, { status: 'completed', title: 'new-title' });

    const row = getTask(t.id)!;
    expect(row.status).toBe('draft'); // 未走 transition：状态保持
    expect(row.title).toBe('new-title'); // 其他字段仍生效
  });

  it('patch 不含 status → 正常更新（基线行为保持）', async () => {
    const t = insertTask({ workspaceId: 'ws1', title: 'orig', creatorUserId: '@owner:home' });
    const handler = handlers.get('task:update')!;
    await handler(null, t.id, { title: 'renamed', priority: 5 });
    const row = getTask(t.id)!;
    expect(row.title).toBe('renamed');
    expect(row.priority).toBe(5);
  });

  it('防御：把终态任务强行 patch status=draft 也不会复活（终态保护）', async () => {
    const t = insertTask({ workspaceId: 'ws1', title: 'doomed', creatorUserId: '@owner:home' });
    transitionTaskStatus(t.id, 'cancelled'); // 用户先取消
    const handler = handlers.get('task:update')!;
    await handler(null, t.id, { status: 'draft', title: 'tried-to-revive' });
    const row = getTask(t.id)!;
    expect(row.status).toBe('cancelled'); // 终态保持
    expect(row.title).toBe('tried-to-revive'); // title 仍可改（这是 task:update 允许的）
  });
});

describe('task:create（v29 委派目标三列 + 循环规则）', () => {
  it('task:create 支持 targetTeamId + 循环规则透传', async () => {
    const handler = handlers.get('task:create');
    expect(handler).toBeDefined();

    const created = await handler!(null, {
      workspaceId: 'ws1',
      title: '循环任务',
      creatorUserId: 'owner',
      targetTeamId: 'team1',
      recurrenceRule: 'daily@09:00',
      scheduledAt: 123,
    });

    // 入参三列 + 循环规则落到返回 row（T1/T4/T6 消费者以此为权威源）
    expect(created.targetTeamId).toBe('team1');
    expect(created.recurrenceRule).toBe('daily@09:00');
    expect(created.scheduledAt).toBe(123);
    // 三列互斥（DB trigger 强制）：未传的两列保持 null
    expect(created.targetSessionId).toBeNull();
    expect(created.assigneeAgentId).toBeNull();
    // 循环实例链由续期写入，新建时恒 null
    expect(created.recurrenceParentId).toBeNull();
  });

  it('task:create 支持 targetSessionId 委派', async () => {
    const handler = handlers.get('task:create')!;
    const created = await handler(null, {
      workspaceId: 'ws1',
      title: 'session 委派任务',
      creatorUserId: 'owner',
      targetSessionId: 'sess-1',
    });
    expect(created.targetSessionId).toBe('sess-1');
    expect(created.targetTeamId).toBeNull();
    expect(created.assigneeAgentId).toBeNull();
  });

  it('task:create 不传三列/规则时仍可用（基线行为保持）', async () => {
    const handler = handlers.get('task:create')!;
    const created = await handler(null, {
      workspaceId: 'ws1',
      title: '普通任务',
      creatorUserId: 'owner',
    });
    expect(created.targetTeamId).toBeNull();
    expect(created.targetSessionId).toBeNull();
    expect(created.recurrenceRule).toBeNull();
  });
});
