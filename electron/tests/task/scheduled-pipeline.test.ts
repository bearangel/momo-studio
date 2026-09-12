// electron/tests/task/scheduled-pipeline.test.ts
//
// C1 定时执行管线接缝测试（spec §4.4）：create 入口落 pending → scheduler
// 到点升级 assigned（认 assignee / team / session 三类目标）→ executor 放行
// in_progress + kickoff 注入。全链真实函数（insertTask / checkOnce /
// startTask / 状态机），仅 kickoff 走注入 fake（momo-test-rules：mock 收窄
// 到进程边界——kickoff 在生产里经 runtime-init 注入 sendUserMessage）。
//
// seed 参考 starter-team.test.ts：workspace + agent 定义/成员 + team。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { TaskScheduler } from '../../src/main/task/scheduler';
import { TaskExecutor } from '../../src/main/task/executor';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-sched-pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/** seed workspace + 两成员团队（leader/member），参考 starter-team.test.ts 的 seed SQL */
function seedTeam(): void {
  const db = getDb();
  db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/tmp', '@o')`).run();
  const insDef = db.prepare(
    `INSERT INTO agent_definitions (id, slug, name, version, system_prompt, model_name)
     VALUES (?, ?, ?, '1', 'p', 'm')`,
  );
  insDef.run('def1', 'coder', 'Coder');
  insDef.run('def2', 'reviewer', 'Reviewer');
  const insMember = db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES (?, 'ws1', ?, ?)`,
  );
  insMember.run('leader1', 'def1', '@leader1:s');
  insMember.run('member1', 'def2', '@member1:s');
  db.prepare(
    `INSERT INTO teams (id, workspace_id, name, icon_emoji, leader_instance_id, created_at)
     VALUES ('team1', 'ws1', '组', '👥', 'leader1', 0)`,
  ).run();
  const insTm = db.prepare(`INSERT INTO team_members (team_id, instance_id, added_at) VALUES ('team1', ?, 0)`);
  insTm.run('leader1');
  insTm.run('member1');
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  seedTeam();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** executor 装配：fake kickoff + 全局并发 3（生产默认装配的等价注入） */
function mkExecutor(): { ex: TaskExecutor; kickoff: ReturnType<typeof vi.fn> } {
  const kickoff = vi.fn().mockResolvedValue(undefined);
  const ex = new TaskExecutor();
  ex.init({ sendKickoff: kickoff, getGlobalMax: () => 3 });
  return { ex, kickoff };
}

describe('定时执行管线（create pending → scheduler 升级 → executor 放行）', () => {
  it('团队目标任务：到点 pending → checkOnce 升 assigned → admitOnce 放行 in_progress + kickoff 一次', async () => {
    insertTask({
      workspaceId: 'ws1',
      title: '定时团队任务',
      creatorUserId: 'owner',
      targetTeamId: 'team1',
      status: 'pending', // create 入口语义：带 scheduledAt 落 pending（spec §4.4）
      scheduledAt: Date.now() - 1000, // 已到点
    });

    const scanPickup = vi.fn().mockResolvedValue(true);
    const sched = new TaskScheduler({ scanPickup });
    sched.checkOnce();

    // 接缝 1：scheduler 认 team 目标（旧实现 WHERE 只认 assignee_agent_id）
    expect(getTask('T-001')!.status).toBe('assigned');
    // team/session 目标无 assignee——scanPickup 收空串（runtime-init 注入的
    // 实现只调 notifyExecutor 不看参数，fire-and-forget 语义）
    expect(scanPickup).toHaveBeenCalledWith('');

    const { ex, kickoff } = mkExecutor();
    await ex.admitOnce();

    // 接缝 2：executor 放行——startTask 走团队分支建执行会话 + kickoff 注入
    const task = getTask('T-001')!;
    expect(task.status).toBe('in_progress');
    expect(task.executionSessionId).not.toBeNull();
    expect(kickoff).toHaveBeenCalledTimes(1);
    expect(kickoff.mock.calls[0]![0]!.sessionId).toBe(task.executionSessionId);
    expect(kickoff.mock.calls[0]![0]!.body).toContain('【任务启动】#T-001');
  });

  it('会话目标任务：到点 pending → checkOnce 升 assigned → admitOnce 就地放行（不新建会话）', async () => {
    const sess = insertSession({ workspaceId: 'ws1', title: '目标会话' });
    insertTask({
      workspaceId: 'ws1',
      title: '定时会话任务',
      creatorUserId: 'owner',
      targetSessionId: sess.id,
      status: 'pending',
      scheduledAt: Date.now() - 1000,
    });

    const scanPickup = vi.fn().mockResolvedValue(true);
    new TaskScheduler({ scanPickup }).checkOnce();

    expect(getTask('T-001')!.status).toBe('assigned');
    expect(scanPickup).toHaveBeenCalledWith('');

    const { ex, kickoff } = mkExecutor();
    await ex.admitOnce();

    const task = getTask('T-001')!;
    expect(task.status).toBe('in_progress');
    expect(task.executionSessionId).toBe(sess.id); // 显式 executionSessionId 路径：就地执行
    expect(kickoff).toHaveBeenCalledTimes(1);
    expect(kickoff.mock.calls[0]![0]!.sessionId).toBe(sess.id);
  });

  it('未到点 / draft 任务：checkOnce 不升级，executor 不放行', async () => {
    insertTask({
      workspaceId: 'ws1',
      title: '未到点团队任务',
      creatorUserId: 'owner',
      targetTeamId: 'team1',
      status: 'pending',
      scheduledAt: Date.now() + 60_000, // 未到点
    });
    insertTask({
      workspaceId: 'ws1',
      title: '草稿任务',
      creatorUserId: 'owner',
      targetTeamId: 'team1',
      status: 'draft',
      scheduledAt: Date.now() - 1000, // 到点但非 pending
    });

    const scanPickup = vi.fn().mockResolvedValue(true);
    new TaskScheduler({ scanPickup }).checkOnce();

    expect(scanPickup).not.toHaveBeenCalled();
    const { ex, kickoff } = mkExecutor();
    await ex.admitOnce();
    expect(kickoff).not.toHaveBeenCalled();
    expect(getTask('T-001')!.status).toBe('pending');
    expect(getTask('T-002')!.status).toBe('draft');
  });
});
