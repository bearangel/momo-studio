// electron/tests/task/starter.test.ts
//
// startTask execution_room 决策树测试（B8）。
//
// 测试覆盖（6 个用例）：
//   1. 用户预设 executionRoomId → 锁定为预设（createdNewRoom=false）
//   2. 无预设 + source_room 存在 → 锁定 source_room（createdNewRoom=false）
//   3. createNewRoom=true → 强制新建会话（命名：任务 #T-XXX: 标题前 20 字）
//   4. 无预设 + 无 source_room → 创建新会话（默认行为）
//   5. status 不是 assigned/pending → 抛 status 错（draft / in_progress 锁定场景除外）
//   6. 已 in_progress 再次启动且 executionRoomId 不同 → 抛"锁定"错（execution_room 不可改）
//
// 测试隔离：每个 case 独立 tmp 目录 + closeDb + AP_USER_DATA_DIR 重置。
// tasks 表有 FK 到 workspaces，故每个 case 都 seed 一个 ws1 工作空间。
// mock 矩阵 rooms/session：避免真实 Conduit 启动，createRoomInSpace 返回固定新 room id。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, transitionTaskStatus } from '../../src/main/storage/tasks/repo';

// Mock Matrix rooms / session：避免真实 Conduit 启动。
// createRoomInSpace 返回固定新 room id '!new-room:home'，便于断言。
vi.mock('../../src/main/matrix/rooms', () => ({
  createRoomInSpace: vi.fn().mockResolvedValue('!new-room:home'),
  createMatrixSpace: vi.fn().mockResolvedValue('!new-space:home'),
  inviteBotToRoom: vi.fn().mockResolvedValue(undefined),
}));
// getCurrentUserId 是同步函数（session.ts 第 51 行），用 mockReturnValue 同步返回。
vi.mock('../../src/main/matrix/session', () => ({
  getOwnerMatrixClient: vi.fn().mockResolvedValue({}),
  getCurrentUserId: vi.fn().mockReturnValue('@owner:home'),
}));

// starter.ts 必须延迟 import（在 vi.mock 注册后），
// 否则模块加载顺序会导致 mock 不生效。
const { startTask } = await import('../../src/main/task/starter');

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-starter-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // seed workspace（tasks 表有 FK 到 workspaces）
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, directory_path, matrix_space_id, owner_id) VALUES (?, ?, ?, ?, ?)`,
    )
    .run('ws1', 'Test', '/tmp', '!space:home', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('startTask execution_room 决策树', () => {
  it('用户预设 executionRoomId → 锁定为预设', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'assigned');
    const result = await startTask(t.id, { executionRoomId: '!preset:home' });
    expect(result.executionRoomId).toBe('!preset:home');
    expect(result.createdNewRoom).toBe(false);
    expect(result.task.status).toBe('in_progress');
    expect(result.task.executionRoomId).toBe('!preset:home');
  });

  it('无预设 + source_room 存在 → 锁定 source_room', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
      sourceRoomId: '!src:home',
    });
    transitionTaskStatus(t.id, 'assigned');
    const result = await startTask(t.id);
    expect(result.executionRoomId).toBe('!src:home');
    expect(result.createdNewRoom).toBe(false);
  });

  it('createNewRoom=true 强制新建会话', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'assigned');
    const result = await startTask(t.id, { createNewRoom: true });
    expect(result.executionRoomId).toBe('!new-room:home');
    expect(result.createdNewRoom).toBe(true);
  });

  it('无预设 + 无 source_room → 创建新会话（命名：任务 #T-XXX: 标题前缀）', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: '实现登录功能详细设计',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'assigned');
    const result = await startTask(t.id);
    expect(result.executionRoomId).toBe('!new-room:home');
    expect(result.createdNewRoom).toBe(true);
  });

  it('status 不是 assigned/pending → 抛错', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    // draft 状态启动应失败
    await expect(startTask(t.id)).rejects.toThrow(/status/);
  });

  it('已 in_progress 再次启动抛错（execution_room 锁定）', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'assigned');
    await startTask(t.id, { executionRoomId: '!first:home' });
    await expect(startTask(t.id, { executionRoomId: '!second:home' })).rejects.toThrow(
      /锁定|locked/,
    );
  });
});
