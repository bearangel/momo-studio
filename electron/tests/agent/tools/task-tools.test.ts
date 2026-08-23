// electron/tests/agent/tools/task-tools.test.ts
//
// 任务工具（read_task / read_task_history / read_task_progress /
//   create_task / complete_task / fail_task / list_tasks）测试。
//
// 设计要点：
//   - 7 个工具是 SQLite 薄包装：read 路径走 SQLiteMemoryProvider（或纯 SELECT），
//     write 路径走 tasks repo。包成 ToolModule 后注册到 registry，统一执行。
//   - 这里只测函数本身（按 brief 的 API 表面），不重复测底层 repo / memory。
//   - 测试隔离：每个 case 用独立 tmp 目录 + closeDb + AP_USER_DATA_DIR 重置。
//     tasks 表有 FK 到 workspaces(id)，故每个 case 都 seed 一个 ws1。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../../src/main/storage/db';
import {
  insertTask,
  transitionTaskStatus,
} from '../../../src/main/storage/tasks/repo';
import { insertMessage } from '../../../src/main/storage/messages/repo';
import { insertEvent } from '../../../src/main/storage/messages/events-repo';
import {
  readTask,
  readTaskHistory,
  readTaskProgress,
  createTask,
  completeTask,
  failTask,
  listTasks,
} from '../../../src/main/agent/tools/task-tools';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-task-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, directory_path, team_session_id, owner_id) VALUES (?, ?, ?, ?, ?)`,
    )
    .run('ws1', 'Test', '/tmp/ws1', '!space:home', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('read_task', () => {
  it('返回 task 上下文摘要（含 events + artifacts 字段）', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      description: 'do',
      creatorUserId: '@owner:home',
    });
    const ctx = await readTask(t.id);
    expect(ctx).toMatchObject({
      id: t.id,
      title: 'T1',
      status: 'draft',
    });
    expect(ctx).toHaveProperty('events');
    expect(ctx).toHaveProperty('artifacts');
  });

  it('task 不存在返回 null', async () => {
    expect(await readTask('nonexistent')).toBeNull();
  });
});

describe('read_task_history', () => {
  it('返回 execution_room 内的 messages（按 createdAt 升序）', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'assigned');
    transitionTaskStatus(t.id, 'in_progress', { executionSessionId: '!room:home' });
    insertMessage({
      sessionId: '!room:home',
      sender: '@owner:home',
      eventType: 'm.room.message',
      body: 'hi',
      taskId: t.id,
    });
    insertMessage({
      sessionId: '!room:home',
      sender: '@bot:home',
      eventType: 'm.room.message',
      body: 'hello',
      taskId: t.id,
    });
    const history = await readTaskHistory(t.id);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ body: 'hi' });
    expect(history[1]).toMatchObject({ body: 'hello' });
  });

  it('task 还没有 execution_room 返回空数组', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    expect(await readTaskHistory(t.id)).toEqual([]);
  });
});

describe('read_task_progress', () => {
  it('返回 task 的 message_events 流（按 createdAt 升序）', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'assigned');
    transitionTaskStatus(t.id, 'in_progress', { executionSessionId: '!room:home' });
    const msg = insertMessage({
      sessionId: '!room:home',
      sender: '@bot:home',
      eventType: 'm.room.message',
      body: '',
      taskId: t.id,
    });
    insertEvent({
      messageId: msg.id,
      seq: 0,
      eventType: 'thinking_delta',
      payload: { delta: 'think' },
    });
    insertEvent({
      messageId: msg.id,
      seq: 1,
      eventType: 'tool_call_start',
      payload: { callId: 'c1', toolName: 'read_file', args: {} },
    });
    const events = await readTaskProgress(t.id);
    expect(events).toHaveLength(2);
    expect(events[0]!.eventType).toBe('thinking_delta');
    expect(events[1]!.eventType).toBe('tool_call_start');
  });

  it('task 还没有 execution_room 返回空数组', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    expect(await readTaskProgress(t.id)).toEqual([]);
  });
});

describe('create_task', () => {
  it('创建任务并返回 draft 状态', async () => {
    const t = await createTask({
      workspaceId: 'ws1',
      title: 'New',
      description: 'desc',
      creatorUserId: '@owner:home',
    });
    expect(t.title).toBe('New');
    expect(t.status).toBe('draft');
    expect(t.description).toBe('desc');
  });
});

describe('complete_task', () => {
  it('把 task 状态改为 completed', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'assigned');
    transitionTaskStatus(t.id, 'in_progress', { executionSessionId: '!room:home' });
    await completeTask(t.id);
    const updated = await readTask(t.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.completedAt).not.toBeNull();
  });
});

describe('fail_task', () => {
  it('把 task 状态改为 failed 并写入 errorMessage', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'assigned');
    transitionTaskStatus(t.id, 'in_progress', { executionSessionId: '!room:home' });
    await failTask(t.id, 'LLM 超时');
    const updated = await readTask(t.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.errorMessage).toBe('LLM 超时');
    expect(updated?.completedAt).not.toBeNull();
  });
});

describe('list_tasks', () => {
  it('按 workspaceId 过滤返回任务列表', async () => {
    insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    insertTask({
      workspaceId: 'ws1',
      title: 'T2',
      creatorUserId: '@owner:home',
    });
    const all = await listTasks({ workspaceId: 'ws1' });
    expect(all).toHaveLength(2);
  });

  it('按 status 过滤', async () => {
    const t1 = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    insertTask({
      workspaceId: 'ws1',
      title: 'T2',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t1.id, 'assigned');
    const assigned = await listTasks({
      workspaceId: 'ws1',
      status: 'assigned',
    });
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.id).toBe(t1.id);
  });
});
