// executor 会话车道 gate（v2.3 spec §4.3）：同会话第二任务转 session_queued
// 不占全局槽；车道空闲后按序放行；无目标会话任务不受车道影响。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { TaskExecutor } from '../../src/main/task/executor';
import type { ExecutorDeps } from '../../src/main/task/executor';
import { __clearLaneForTest } from '../../src/main/agent/session-lane';

const tmpRoot = path.join(os.tmpdir(), `ap-exec-lane-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/tmp', '@o')`)
    .run();
  __clearLaneForTest();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 与 executor.test.ts 同款 agent 成员 seed（DDL 对齐 v25 schema） */
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

describe('TaskExecutor 会话车道 gate（v2.3）', () => {
  it('同会话双任务：第一个 in_progress，第二个转 session_queued 且不占全局槽', async () => {
    seedAgentMember('inst1');
    const session = insertSession({ workspaceId: 'ws1', title: '任务研发', kind: 'task_execution' });
    addSessionMember(session.id, 'inst1', true);
    // A 优先级高先放行；B 同会话低优先级
    // 委派目标三列互斥（v29 trigger）→ targetSessionId 已指明会话，instance 由
    // 会话成员表（addSessionMember 上方）提供路由目标，不重复填 assigneeAgentId
    insertTask({ workspaceId: 'ws1', title: 'A', creatorUserId: 'o', targetSessionId: session.id, status: 'assigned', priority: 10 });
    insertTask({ workspaceId: 'ws1', title: 'B', creatorUserId: 'o', targetSessionId: session.id, status: 'assigned', priority: 5 });

    const kickoff = vi.fn().mockResolvedValue(undefined);
    const ex = mkExecutor(3, kickoff);
    await ex.admitOnce();

    // T-001=A 高优先级放行；startTask 已写 in_progress DB 行（车道 DB 兜底占道）
    expect(getTask('T-001')!.status).toBe('in_progress');
    expect(getTask('T-002')!.status).toBe('session_queued');
    expect(kickoff).toHaveBeenCalledTimes(1);
    expect(kickoff.mock.calls[0]![0].taskId).toBe('T-001');
  });

  it('车道空闲（in_progress 行已终态化）后放行 session_queued 队首', async () => {
    seedAgentMember('inst1');
    const session = insertSession({ workspaceId: 'ws1', title: '任务研发', kind: 'task_execution' });
    addSessionMember(session.id, 'inst1', true);
    // A 已完成（DB 无 in_progress 行，lane 内存为空）→ B 从排队态放行
    insertTask({ workspaceId: 'ws1', title: 'A', creatorUserId: 'o', targetSessionId: session.id, status: 'completed' });
    insertTask({ workspaceId: 'ws1', title: 'B', creatorUserId: 'o', targetSessionId: session.id, status: 'session_queued' });

    const kickoff = vi.fn().mockResolvedValue(undefined);
    const ex = mkExecutor(3, kickoff);
    await ex.admitOnce();

    expect(getTask('T-002')!.status).toBe('in_progress');
    expect(kickoff).toHaveBeenCalledTimes(1);
    expect(kickoff.mock.calls[0]![0].taskId).toBe('T-002');
  });

  it('无目标会话任务（startTask 新建会话路径）不受车道影响', async () => {
    seedAgentMember('inst1');
    insertTask({ workspaceId: 'ws1', title: 'C', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned' });

    const kickoff = vi.fn().mockResolvedValue(undefined);
    const ex = mkExecutor(3, kickoff);
    await ex.admitOnce();

    expect(getTask('T-001')!.status).toBe('in_progress');
    expect(kickoff).toHaveBeenCalledTimes(1);
  });
});
