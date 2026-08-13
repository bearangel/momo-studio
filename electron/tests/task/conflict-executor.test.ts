// electron/tests/task/conflict-executor.test.ts
//
// executeConflictResolution 测试（B 子系统 B9）。
//
// executeConflictResolution 把纯函数 resolveConflict 的结果映射到实际副作用：
//   - queue  → 无副作用（newTask 保持 assigned，等 D 阶段 pickup）
//   - preempt→ transitionTaskStatus(currentTask, 'paused') + startTask(newTask, currentRoom)
//   - fork   → startTask(newTask, { createNewRoom: true })
//   - reject → 无副作用
//
// 测试隔离与 starter.test.ts 同：tmp 目录 + closeDb + mock Matrix rooms/session。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, transitionTaskStatus, getTask } from '../../src/main/storage/tasks/repo';

vi.mock('../../src/main/matrix/rooms', () => ({
  createRoomInSpace: vi.fn().mockResolvedValue('!new-room:home'),
  createMatrixSpace: vi.fn().mockResolvedValue('!new-space:home'),
  inviteBotToRoom: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/main/matrix/session', () => ({
  getOwnerMatrixClient: vi.fn().mockResolvedValue({}),
  getCurrentUserId: vi.fn().mockReturnValue('@owner:home'),
}));

const { executeConflictResolution } = await import('../../src/main/task/conflict-executor');

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-conflict-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
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

function seedTwoTasks() {
  const current = insertTask({ workspaceId: 'ws1', title: '当前任务', creatorUserId: '@owner:home' });
  const next = insertTask({ workspaceId: 'ws1', title: '新任务', creatorUserId: '@owner:home' });
  transitionTaskStatus(current.id, 'assigned');
  transitionTaskStatus(next.id, 'assigned');
  return { current, next };
}

describe('executeConflictResolution', () => {
  it('queue → 无副作用（currentTask 保持 in_progress，newTask 保持 assigned）', async () => {
    const { current, next } = seedTwoTasks();
    const started = transitionTaskStatus(current.id, 'in_progress');
    const ctx = {
      newTaskId: next.id,
      currentTaskId: current.id,
      currentRoomId: '!room:home',
    };
    const result = await executeConflictResolution({ action: 'queue', newTaskId: next.id }, ctx);
    expect(result.action).toBe('queue');
    expect(getTask(current.id)!.status).toBe('in_progress');
    expect(getTask(next.id)!.status).toBe('assigned');
  });

  it('preempt → currentTask → paused + newTask → in_progress', async () => {
    const { current, next } = seedTwoTasks();
    transitionTaskStatus(current.id, 'in_progress');
    const ctx = {
      newTaskId: next.id,
      currentTaskId: current.id,
      currentRoomId: '!room:home',
    };
    const result = await executeConflictResolution(
      { action: 'preempt', newTaskId: next.id, pausedTaskId: current.id },
      ctx,
    );
    expect(result.action).toBe('preempt');
    expect(getTask(current.id)!.status).toBe('paused');
    expect(getTask(next.id)!.status).toBe('in_progress');
    expect(getTask(next.id)!.executionRoomId).toBe('!room:home');
  });

  it('fork → newTask 在新会话启动（createdNewRoom）', async () => {
    const { next } = seedTwoTasks();
    const ctx = {
      newTaskId: next.id,
      currentTaskId: 'T-unused',
      currentRoomId: '!room:home',
    };
    const result = await executeConflictResolution(
      { action: 'fork', newTaskId: next.id, newExecutionRoomId: '!placeholder:home' },
      ctx,
    );
    expect(result.action).toBe('fork');
    expect(getTask(next.id)!.status).toBe('in_progress');
    // startTask(createNewRoom: true) → mock 返回 '!new-room:home'
    expect(getTask(next.id)!.executionRoomId).toBe('!new-room:home');
  });

  it('reject → 无副作用', async () => {
    const { current, next } = seedTwoTasks();
    transitionTaskStatus(current.id, 'in_progress');
    const ctx = {
      newTaskId: next.id,
      currentTaskId: current.id,
      currentRoomId: '!room:home',
    };
    const result = await executeConflictResolution(
      { action: 'reject', reason: '测试拒绝' },
      ctx,
    );
    expect(result.action).toBe('reject');
    expect(getTask(current.id)!.status).toBe('in_progress');
    expect(getTask(next.id)!.status).toBe('assigned');
  });
});
