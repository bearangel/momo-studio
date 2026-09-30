// electron/tests/task/lifecycle.test.ts
//
// 看板重构 Task 4 回归锁：start / resume-paused / cancel 三生命周期动作从
// ipc.handlers.ts 抽取为共享模块 lifecycle.ts（机械搬运，行为零变化）。
// Task 5 的 move.ts 将同源消费这三个导出——本文件锁的就是抽取后的语义：
//   - startTaskAndKickoff：K9 全语义（startTask + 幂等判定 + kickoff 注入 +
//     失败转 failed + broadcast/notify）
//   - resumePausedTask：K7-5（transition + kickoff 重注入 + broadcast/notify）
//   - cancelTask：transition cancelled + abortTaskExecution + broadcast/notify
//   - abortTaskExecution（Task 7 铺路）：只 abort 运行时流，不动 DB 状态
//
// mock 边界（momo-test-rules）：只 mock 进程/会话服务边界——sendUserMessage
// 内部是 insertMessage + 接待路由重链路，拦截为成功值并断言 kickoff 载荷；
// abortTasksBySessionEverywhere 是 runtime 注册表边界。状态机 / repo /
// starter / executor 全部真实运行。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, transitionTaskStatus } from '../../src/main/storage/tasks/repo';
import * as sessionServiceMod from '../../src/main/im/session-service';
import * as runtimeRegistryMod from '../../src/main/agent/runtime-registry';
import { startTaskAndKickoff, resumePausedTask, cancelTask, abortTaskExecution } from '../../src/main/task/lifecycle';

// spy 模块导出（tsc→CJS 编译为属性访问，spy 生效——同 ipc-handlers.test.ts
// 先例），不断言内部实现。sendUserMessage 全文件拦截为成功值（真身是
// insertMessage + 接待路由重链路，本文件只断言 kickoff 载荷参数）。
const sendUserMessageSpy = vi
  .spyOn(sessionServiceMod, 'sendUserMessage')
  .mockResolvedValue({ ok: true } as never);
// K10 语义：新建执行会话 → 通知 renderer 刷新会话列表（真实实现测试环境安全，直通）
const sessionListChangedSpy = vi.spyOn(sessionServiceMod, 'broadcastSessionListChanged');
// K7-4：abort 按 executionSessionId 匹配的 runtime 注册表边界
const abortSpy = vi.spyOn(runtimeRegistryMod, 'abortTasksBySessionEverywhere');

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/** seed 一个 workspace 成员 agent（session_members FK 需要——同 K9 测试先例） */
function seedAgentMember(instanceId: string): void {
  getDb()
    .prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name, icon_emoji)
       VALUES (?, 'Worker', ?, '1', 'declarative', 'p', '[]', 'custom', 'm', '🤖')`,
    )
    .run(`def-${instanceId}`, `slug-${instanceId}`);
  getDb()
    .prepare(
      `INSERT INTO workspace_agent_members
         (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
       VALUES (?, 'ws1', ?, ?, 0)`,
    )
    .run(instanceId, `def-${instanceId}`, `@${instanceId}:s`);
}

/**
 * seed 一个已启动任务（走生产合法链：assigned → in_progress(+会话) [→ paused]），
 * 比直插 status 更贴真实运行时语义（momo-test-rules 第 1 条）。
 */
function seedStartedTask(opts: {
  title: string;
  assignee: string;
  execSessionId: string;
  paused?: boolean;
}): string {
  const t = insertTask({
    workspaceId: 'ws1',
    title: opts.title,
    creatorUserId: '@owner:home',
    assigneeAgentId: opts.assignee,
    status: 'assigned',
  });
  transitionTaskStatus(t.id, 'in_progress', { executionSessionId: opts.execSessionId });
  if (opts.paused) transitionTaskStatus(t.id, 'paused');
  return t.id;
}

beforeEach(() => {
  // 清调用记录不清实现（mockResolvedValue 基线保留）——spy 计数跨用例隔离
  vi.clearAllMocks();
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
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

describe('startTaskAndKickoff（K9 全语义）', () => {
  it('assigned 任务启动后 in_progress 且注入 kickoff（Review Focus ②）', async () => {
    seedAgentMember('inst-start');
    const t = insertTask({
      workspaceId: 'ws1',
      title: '手动启动',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-start',
      status: 'assigned',
    });

    const res = await startTaskAndKickoff(t.id);

    expect(res.task.status).toBe('in_progress');
    expect(res.createdNewRoom).toBe(true);
    expect(res.executionSessionId).toBeTruthy();
    expect(getTask(t.id)?.status).toBe('in_progress');
    expect(getTask(t.id)?.executionSessionId).not.toBeNull();
    // K10：新建执行会话 → 通知 renderer 刷新会话列表
    expect(sessionListChangedSpy).toHaveBeenCalledTimes(1);
    // kickoff 载荷：注入执行会话 + mention assignee + systemKickoff 标记
    expect(sendUserMessageSpy).toHaveBeenCalledTimes(1);
    const kickoff = sendUserMessageSpy.mock.calls[0]![0] as {
      sessionId: string;
      body: string;
      mentionedInstanceIds?: string[];
      systemKickoff?: boolean;
    };
    expect(kickoff.sessionId).toBe(res.executionSessionId);
    expect(kickoff.body).toContain(t.id);
    expect(kickoff.mentionedInstanceIds).toEqual(['inst-start']);
    expect(kickoff.systemKickoff).toBe(true);
  });

  it('kickoff 失败 → 任务转 failed 且透出错误', async () => {
    seedAgentMember('inst-fail');
    const t = insertTask({
      workspaceId: 'ws1',
      title: '失败启动',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-fail',
      status: 'assigned',
    });
    sendUserMessageSpy.mockRejectedValueOnce(new Error('boom'));

    await expect(startTaskAndKickoff(t.id)).rejects.toThrow('boom');

    // 半启动不可恢复 → 与 executor failQuietly 同语义转 failed，错误信息透出
    expect(getTask(t.id)?.status).toBe('failed');
    expect(getTask(t.id)?.errorMessage).toContain('kickoff');
  });

  it('已 in_progress 幂等返回 → 不重复注入 kickoff', async () => {
    seedAgentMember('inst-idem');
    const t = insertTask({
      workspaceId: 'ws1',
      title: '幂等启动',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-idem',
      status: 'assigned',
    });

    await startTaskAndKickoff(t.id); // 首次启动：注入一次
    await startTaskAndKickoff(t.id); // 幂等返回：不再注入

    expect(sendUserMessageSpy).toHaveBeenCalledTimes(1);
  });
});

describe('resumePausedTask（K7-5）', () => {
  it('paused → in_progress + kickoff 重注入执行会话', async () => {
    seedAgentMember('inst-resume');
    const taskId = seedStartedTask({
      title: '恢复任务',
      assignee: 'inst-resume',
      execSessionId: 'sess-resume',
      paused: true,
    });

    const row = await resumePausedTask(taskId);

    expect(row.status).toBe('in_progress');
    expect(row.executionSessionId).toBe('sess-resume');
    expect(sendUserMessageSpy).toHaveBeenCalledTimes(1);
    const kickoff = sendUserMessageSpy.mock.calls[0]![0] as {
      sessionId: string;
      body: string;
      mentionedInstanceIds?: string[];
      systemKickoff?: boolean;
    };
    expect(kickoff.sessionId).toBe('sess-resume');
    expect(kickoff.body).toContain(taskId);
    expect(kickoff.mentionedInstanceIds).toEqual(['inst-resume']);
    expect(kickoff.systemKickoff).toBe(true);
  });
});

describe('cancelTask', () => {
  it('in_progress → cancelled + 联动中断执行会话', async () => {
    const taskId = seedStartedTask({
      title: '取消任务',
      assignee: 'inst-cancel',
      execSessionId: 'sess-cancel',
    });

    await cancelTask(taskId);

    expect(getTask(taskId)?.status).toBe('cancelled');
    expect(abortSpy).toHaveBeenCalledWith('sess-cancel');
  });

  it('无执行会话的任务取消 → 不触发中断', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: '未启动取消',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-cancel2',
      status: 'assigned',
    });

    await cancelTask(t.id);

    expect(getTask(t.id)?.status).toBe('cancelled');
    expect(abortSpy).not.toHaveBeenCalled();
  });
});

describe('abortTaskExecution（Task 7 铺路：只 abort 运行时流，不 transition）', () => {
  it('in_progress + executionSessionId 任务调用后 DB 状态不变（仅运行时副作用）', () => {
    const taskId = seedStartedTask({
      title: '仅中止',
      assignee: 'inst-abort',
      execSessionId: 'sess-abort',
    });

    abortTaskExecution(taskId);

    // DB 侧：状态原样保持（cancelTask 之外的独立调用不携带 transition）
    expect(getTask(taskId)?.status).toBe('in_progress');
    // 运行时侧：车道无记录 → 回退按 executionSessionId 广播（K7-4 兜底语义）
    expect(abortSpy).toHaveBeenCalledWith('sess-abort');
  });

  it('无执行会话的任务 → 静默 no-op', () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: '无会话中止',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-abort2',
      status: 'assigned',
    });

    expect(() => abortTaskExecution(t.id)).not.toThrow();
    expect(abortSpy).not.toHaveBeenCalled();
  });
});
