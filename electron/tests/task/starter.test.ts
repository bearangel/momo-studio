// electron/tests/task/starter.test.ts
//
// startTask execution_room 决策树测试（B8）。
//
// 测试覆盖：
//   1. 用户预设 executionSessionId → 锁定为预设（createdNewRoom=false）
//   2. 无预设 + source_room 存在 → 锁定 source_room（createdNewRoom=false）
//   3. createNewRoom=true → 强制新建会话（本地 sessions 表行，kind=task_execution）
//   4. 无预设 + 无 source_room → 创建新会话（默认行为，命名：任务 #T-XXX: 标题前 20 字）
//   5. status 不是 assigned/pending → 抛 status 错（draft / in_progress 锁定场景除外）
//   6. 已 in_progress 再次启动且 executionSessionId 不同 → 抛"锁定"错（execution_room 不可改）
//   7. 新建会话且有 assignee → assignee 写入 session_members（v2 P1 Task 11：本地成员表，
//      原 Matrix inviteBotToRoom 已删）
//   8. Task 12 原子性：三步写包任一步失败（assignee FK 不合法）→ 整笔回滚，
//      无 orphan session、任务停留 assigned
//
// 测试隔离：每个 case 独立 tmp 目录 + closeDb + AP_USER_DATA_DIR 重置。
// tasks 表有 FK 到 workspaces，故每个 case 都 seed 一个 ws1 工作空间。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, transitionTaskStatus } from '../../src/main/storage/tasks/repo';
import { listSessionMembers } from '../../src/main/storage/sessions/repo';

// starter.ts 必须延迟 import（保持在顶层 await 语义），与实现模块解耦。
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
      `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`,
    )
    .run('ws1', 'Test', '/tmp', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('startTask execution_room 决策树', () => {
  it('用户预设 executionSessionId → 锁定为预设', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'assigned');
    const result = await startTask(t.id, { executionSessionId: '!preset:home' });
    expect(result.executionSessionId).toBe('!preset:home');
    expect(result.createdNewRoom).toBe(false);
    expect(result.task.status).toBe('in_progress');
    expect(result.task.executionSessionId).toBe('!preset:home');
  });

  it('无预设 + source_room 存在 → 锁定 source_room', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
      sourceSessionId: '!src:home',
    });
    transitionTaskStatus(t.id, 'assigned');
    const result = await startTask(t.id);
    expect(result.executionSessionId).toBe('!src:home');
    expect(result.createdNewRoom).toBe(false);
  });

  it('createNewRoom=true 强制新建会话（本地 sessions 表，kind=task_execution）', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'assigned');
    const result = await startTask(t.id, { createNewRoom: true });
    expect(result.createdNewRoom).toBe(true);
    const row = getDb()
      .prepare('SELECT id, kind, workspace_id FROM sessions WHERE id = ?')
      .get(result.executionSessionId) as { id: string; kind: string; workspace_id: string };
    expect(row).toBeDefined();
    expect(row.kind).toBe('task_execution');
    expect(row.workspace_id).toBe('ws1');
  });

  it('无预设 + 无 source_room → 创建新会话（命名：任务 #T-XXX: 标题前 20 字）', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: '实现登录功能详细设计',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'assigned');
    const result = await startTask(t.id);
    expect(result.createdNewRoom).toBe(true);
    const row = getDb()
      .prepare('SELECT title FROM sessions WHERE id = ?')
      .get(result.executionSessionId) as { title: string };
    expect(row.title).toBe(`任务 #${t.id}: 实现登录功能详细设计`);
  });

  it('新建会话且有 assignee → assignee 写入 session_members', async () => {
    // session_members 有 FK 到 workspace_agent_members，先 seed 定义 + 成员
    getDb()
      .prepare(
        `INSERT INTO agent_definitions
           (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name, icon_emoji)
         VALUES ('def-1', 'Worker', 'worker', '1', 'declarative', 'p', '[]', 'custom', 'm', '🤖')`,
      )
      .run();
    getDb()
      .prepare(
        `INSERT INTO workspace_agent_members
           (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
         VALUES ('inst-agent-1', 'ws1', 'def-1', '@inst-agent-1:s', 0)`,
      )
      .run();
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-agent-1',
    });
    transitionTaskStatus(t.id, 'assigned');
    const result = await startTask(t.id, { createNewRoom: true });
    const members = listSessionMembers(result.executionSessionId);
    expect(members.map((m) => m.instanceId)).toEqual(['inst-agent-1']);
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
    await startTask(t.id, { executionSessionId: '!first:home' });
    await expect(startTask(t.id, { executionSessionId: '!second:home' })).rejects.toThrow(
      /锁定|locked/,
    );
  });

  it('三步写包原子性：addSessionMember FK 失败 → 整笔回滚（无 orphan session，任务停留 assigned）', async () => {
    // assignee 指向不存在的 assignment——addSessionMember 的 FK 约束必然失败
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-not-exist',
    });
    transitionTaskStatus(t.id, 'assigned');

    await expect(startTask(t.id, { createNewRoom: true })).rejects.toThrow();

    // 回滚断言 1：没有留下任何 task_execution 会话（orphan session）
    const sessions = getDb()
      .prepare('SELECT id FROM sessions WHERE workspace_id = ?')
      .all('ws1') as Array<{ id: string }>;
    expect(sessions).toEqual([]);

    // 回滚断言 2：任务未被推进 in_progress（可重试）
    const after = getDb()
      .prepare('SELECT status FROM tasks WHERE id = ?')
      .get(t.id) as { status: string };
    expect(after.status).toBe('assigned');

    // 回滚断言 3：补齐 assignee 的成员行后重试可成功（半状态未污染后续启动）
    getDb()
      .prepare(
        `INSERT INTO agent_definitions
           (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name, icon_emoji)
         VALUES ('def-2', 'Worker', 'worker', '1', 'declarative', 'p', '[]', 'custom', 'm', '🤖')`,
      )
      .run();
    getDb()
      .prepare(
        `INSERT INTO workspace_agent_members
           (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
         VALUES ('inst-not-exist', 'ws1', 'def-2', '@inst-not-exist:s', 0)`,
      )
      .run();
    const retry = await startTask(t.id, { createNewRoom: true });
    expect(retry.task.status).toBe('in_progress');
    expect(listSessionMembers(retry.executionSessionId).map((m) => m.instanceId)).toEqual([
      'inst-not-exist',
    ]);
  });
});
