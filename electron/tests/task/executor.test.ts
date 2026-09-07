// electron/tests/task/executor.test.ts
//
// TaskExecutor 放行测试（spec §5.1）：全局并发 gate / 放行排序 /
// 目标校验失败→failed / kickoff 失败→failed / 会话目标走显式 executionSessionId。
// kickoff 走注入的 fake（不依赖 session-service / router 真链路）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, listTasks } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { TaskExecutor } from '../../src/main/task/executor';
import type { ExecutorDeps } from '../../src/main/task/executor';

const tmpRoot = path.join(os.tmpdir(), `ap-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/tmp', '@o')`)
    .run();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** agent 目标合法 seed：workspace_agent_members 有 inst1。
 *  按 Task 3 同款 DDL 修正（brief 原始 seed 缺 NOT NULL 列）：
 *  agent_definitions 当前 NOT NULL：id/name/slug/version/system_prompt/model_name
 *  （model_provider 已在 v13 DROP，无 updated_at 列）；workspace_agent_members
 *  当前 NOT NULL：instance_id/workspace_id/agent_definition_id/agent_user_id
 *  （时间列是 created_at 带 DEFAULT，无 added_at 列）。 */
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

describe('TaskExecutor.admitOnce', () => {
  it('并发满 → assigned 不放行', async () => {
    seedAgentMember('inst1');
    insertTask({ workspaceId: 'ws1', title: 'running', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'in_progress', startedAt: Date.now() });
    insertTask({ workspaceId: 'ws1', title: 'waiting', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned' });
    const ex = mkExecutor(1, vi.fn().mockResolvedValue(undefined));
    await ex.admitOnce();
    expect(getTask('T-002')!.status).toBe('assigned'); // 满 1 不放行
  });

  it('有空位 → 按优先级放行 + kickoff 注入执行会话（agent 目标带 mention）', async () => {
    seedAgentMember('inst1');
    insertTask({ workspaceId: 'ws1', title: 'low', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned', priority: 1 });
    insertTask({ workspaceId: 'ws1', title: 'high', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned', priority: 10 });
    const kickoff = vi.fn().mockResolvedValue(undefined);
    const ex = mkExecutor(1, kickoff);
    await ex.admitOnce();

    expect(getTask('T-002')!.status).toBe('in_progress'); // 高优先级先放行
    expect(getTask('T-001')!.status).toBe('assigned');
    expect(kickoff).toHaveBeenCalledTimes(1);
    const call = kickoff.mock.calls[0][0];
    expect(call.mentionedInstanceIds).toEqual(['inst1']);
    expect(call.body).toContain('【任务启动】#T-002 · high');
    expect(getTask('T-002')!.executionSessionId).toBe(call.sessionId);
  });

  it('目标无效（agent 已移除）→ 转 failed 带明示错误，不占槽，后续候选继续', async () => {
    seedAgentMember('inst1');
    insertTask({ workspaceId: 'ws1', title: 'orphan', creatorUserId: 'o', assigneeAgentId: 'gone', status: 'assigned', priority: 10 });
    insertTask({ workspaceId: 'ws1', title: 'ok', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned', priority: 1 });
    const ex = mkExecutor(1, vi.fn().mockResolvedValue(undefined));
    await ex.admitOnce();

    const orphan = getTask('T-001')!;
    expect(orphan.status).toBe('failed');
    expect(orphan.errorMessage).toContain('指派 agent');
    expect(getTask('T-002')!.status).toBe('in_progress'); // 失败不占槽，下一个顶上
  });

  it('会话目标任务 → kickoff 进目标会话（显式 executionSessionId 路径）', async () => {
    // kind 按 sessions DDL CHECK 约束修正：合法值只有 'chat' | 'task_execution'
    // （brief 原写的 'quick' 是 v25 概念模型里的会话双类型用语，未落 DDL）
    const sess = insertSession({ workspaceId: 'ws1', title: '已有会话', kind: 'chat' });
    insertTask({ workspaceId: 'ws1', title: 'inplace', creatorUserId: 'o', targetSessionId: sess.id, status: 'assigned' });
    const kickoff = vi.fn().mockResolvedValue(undefined);
    await mkExecutor(3, kickoff).admitOnce();

    const t = getTask('T-001')!;
    expect(t.status).toBe('in_progress');
    expect(t.executionSessionId).toBe(sess.id);
    expect(kickoff.mock.calls[0][0].sessionId).toBe(sess.id);
    expect(kickoff.mock.calls[0][0].mentionedInstanceIds).toBeUndefined(); // 会话目标不 mention → 接待路由
  });

  it('kickoff 抛错 → 任务转 failed 带错误信息', async () => {
    seedAgentMember('inst1');
    insertTask({ workspaceId: 'ws1', title: 'boom', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned' });
    const kickoff = vi.fn().mockRejectedValue(new Error('session 服务不可用'));
    await mkExecutor(3, kickoff).admitOnce();

    const t = getTask('T-001')!;
    expect(t.status).toBe('failed');
    expect(t.errorMessage).toContain('session 服务不可用');
  });

  it('pending（未到点）与 draft 不参与放行', async () => {
    seedAgentMember('inst1');
    insertTask({ workspaceId: 'ws1', title: 'p', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'pending', scheduledAt: Date.now() + 60_000 });
    insertTask({ workspaceId: 'ws1', title: 'd', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'draft' });
    const kickoff = vi.fn().mockResolvedValue(undefined);
    await mkExecutor(3, kickoff).admitOnce();
    expect(kickoff).not.toHaveBeenCalled();
    expect(listTasks({ workspaceId: 'ws1', status: 'in_progress' })).toHaveLength(0);
  });
});
