// electron/tests/task/executor.test.ts
//
// TaskExecutor 放行测试（spec §5.1）：全局并发 gate / 放行排序 /
// 目标校验失败→failed / kickoff 失败→failed / 会话目标走显式 executionSessionId /
// startTask 抛错→本轮跳过（无死循环）。
// kickoff 走注入的 fake（不依赖 session-service / router 真链路）。
// startTask 通过 module-level vi.mock 收窄劫持，仅当新 case 的
// `rejectStartTaskForId` 标志命中时才抛错；其他 6 个 case 走真实实现。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, listTasks } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { TaskExecutor } from '../../src/main/task/executor';
import type { ExecutorDeps } from '../../src/main/task/executor';

/**
 * startTask 抛错路径回归锁专用：模块级 mock + 闭包开关。
 * vi.mock 是 module 级且 hoisted——同一份 mock 实现贯穿全文件；
 * 仅当本变量被设为某个 taskId 时，该 id 走抛错分支，其他场景一律透传
 * 真实实现，避免污染既有的 6 个用例（其中两个会调 startTask('T-001')，
 * 若固定拦截 T-001 会让它们也挂掉）。
 */
let rejectStartTaskForId: string | null = null;

vi.mock('../../src/main/task/starter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/task/starter')>();
  return {
    ...actual,
    startTask: vi.fn(async (taskId: string, opts?: Parameters<typeof actual.startTask>[1]) => {
      if (rejectStartTaskForId !== null && taskId === rejectStartTaskForId) {
        throw new Error('状态竞态：行已被并发改态');
      }
      return actual.startTask(taskId, opts);
    }),
  };
});

const tmpRoot = path.join(os.tmpdir(), `ap-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  rejectStartTaskForId = null; // 新 case 在 it() 内覆写，其他 6 个 case 保持透传
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

  it('三目标列全空的 assigned → 转 failed（任务无委派目标，无法自动执行）', async () => {
    // 手动 transition 产出的无目标 assigned 边角：不能静默新建会话放行，
    // 必须明示失败让用户看到（spec §9 边界表）
    insertTask({ workspaceId: 'ws1', title: 'orphan', creatorUserId: 'o', status: 'assigned' });
    const kickoff = vi.fn().mockResolvedValue(undefined);
    await mkExecutor(3, kickoff).admitOnce();

    const t = getTask('T-001')!;
    expect(t.status).toBe('failed');
    expect(t.errorMessage).toContain('无委派目标');
    expect(kickoff).not.toHaveBeenCalled();
  });

  it('startTask 抛错 → 该候选本轮跳过保持 assigned，后续候选继续放行，无死循环', async () => {
    // 守护点：executor.admitOnce 第 102 行 skipped.add(candidate.id)。
    // 若丢了这行，while 内同一候选会被反复选中，startTask 持续抛错，
    // admitOnce 永不返回——admitOnce() 能 resolve 本身就是「无死循环」的回归证据。
    seedAgentMember('inst1');
    insertTask({ workspaceId: 'ws1', title: 'high', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned', priority: 10 });
    insertTask({ workspaceId: 'ws1', title: 'low', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned', priority: 1 });
    // 启用收窄抛错：仅 T-001 走抛错分支，T-002 走真实 startTask
    rejectStartTaskForId = 'T-001';
    const kickoff = vi.fn().mockResolvedValue(undefined);
    const ex = mkExecutor(3, kickoff);

    // 无死循环证明：以下 await 能 resolve
    await ex.admitOnce();

    // T-001（高优先级，startTask 抛错）：本轮跳过，保持 assigned；
    // launch 的 catch 静默吞掉（logger.warn），不写 errorMessage 列——
    // 不同于 failQuietly 路径（目标无效 / kickoff 失败会写）。
    const high = getTask('T-001')!;
    expect(high.status).toBe('assigned');
    expect(high.errorMessage).toBeNull();

    // T-002（低优先级，正常 startTask + kickoff）：放行进 in_progress，
    // kickoff 仅被调用一次（即 T-002 的会话），T-001 的失败未污染下游
    const low = getTask('T-002')!;
    expect(low.status).toBe('in_progress');
    expect(kickoff).toHaveBeenCalledTimes(1);
    expect(kickoff.mock.calls[0][0].sessionId).toBe(low.executionSessionId);
  });
});
