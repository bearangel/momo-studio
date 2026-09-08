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
import * as executorMod from '../../src/main/task/executor';
import * as taskBroadcastMod from '../../src/main/p2p/task-broadcast';
import * as runtimeRegistryMod from '../../src/main/agent/runtime-registry';
import * as sessionServiceMod from '../../src/main/im/session-service';

// K3：task:update 成功后需触发调度重评估 + P2P 快照广播——spy 模块导出
// （tsc→CJS 编译为属性访问，spy 生效），不断言内部实现
const notifyExecutorSpy = vi.spyOn(executorMod, 'notifyExecutor');
const broadcastSpy = vi.spyOn(taskBroadcastMod, 'broadcastLocalTaskSnapshot');
// K7-4/K7-5：暂停/取消联动中断 + resume kickoff 重注入——同样 spy 模块边界
const abortSpy = vi.spyOn(runtimeRegistryMod, 'abortTasksBySessionEverywhere');
const sendUserMessageSpy = vi.spyOn(sessionServiceMod, 'sendUserMessage');
// K10：新建执行会话 → 通知 renderer 刷新会话列表（停留 IM 视图时新会话实时出现）
const sessionListChangedSpy = vi.spyOn(sessionServiceMod, 'broadcastSessionListChanged');

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
  notifyExecutorSpy.mockClear();
  broadcastSpy.mockClear();
  abortSpy.mockClear();
  sendUserMessageSpy.mockClear();
  sessionListChangedSpy.mockClear();
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

  // K3 回归锁（P0 修复）：旧实现 task:update 成功后不触发 notifyExecutor /
  // 快照广播（其余四个写通道都有）——编辑改了 assignee 的排队任务，
  // executor 不会为新指派重评估，看板远端镜像也不同步。
  it('K3: task:update 成功 → 触发调度重评估 + P2P 快照广播', async () => {
    const t = insertTask({ workspaceId: 'ws1', title: 'orig', creatorUserId: '@owner:home' });
    const handler = handlers.get('task:update')!;
    await handler(null, t.id, { assigneeAgentId: 'inst-new' });

    expect(notifyExecutorSpy).toHaveBeenCalledTimes(1);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
  });

  it('K3: task:update 前置校验失败（任务不存在）→ 不触发通知', async () => {
    const handler = handlers.get('task:update')!;
    await expect(handler(null, 'T-9999', { title: 'nope' })).rejects.toThrow();
    expect(notifyExecutorSpy).not.toHaveBeenCalled();
    expect(broadcastSpy).not.toHaveBeenCalled();
  });
});

// K7-4/K7-5：任务暂停/取消 ↔ agent 执行的双向联动。
// 暂停/取消只改 DB 是半套语义——agent 还在跑（token 白烧 + 状态漂移）；
// 联动 abort 按 executionSessionId 匹配（kickoff 驱动的流是 ephemeral，
// taskId=null）。resume 反向：paused → in_progress + kickoff 重注入。
describe('任务暂停/取消 ↔ agent 执行联动（K7-4/K7-5）', () => {
  /** seed 一个 paused 任务（带执行会话 + assignee），走过完整合法链 */
  function seedPausedTask(execSessionId: string): string {
    const t = insertTask({
      workspaceId: 'ws1',
      title: '联动任务',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-x',
      status: 'assigned',
    });
    transitionTaskStatus(t.id, 'in_progress', { executionSessionId: execSessionId });
    transitionTaskStatus(t.id, 'paused');
    return t.id;
  }

  it('K7-4: transition → paused → 联动中断该任务执行会话的活跃流', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: '暂停联动',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-x',
      status: 'assigned',
    });
    transitionTaskStatus(t.id, 'in_progress', { executionSessionId: 'sess-lex' });

    const handler = handlers.get('task:transition')!;
    await handler(null, t.id, 'paused');

    expect(getTask(t.id)!.status).toBe('paused');
    expect(abortSpy).toHaveBeenCalledWith('sess-lex');
  });

  it('K7-4: task:cancel → 联动中断', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: '取消联动',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-x',
      status: 'assigned',
    });
    transitionTaskStatus(t.id, 'in_progress', { executionSessionId: 'sess-cex' });

    const handler = handlers.get('task:cancel')!;
    await handler(null, t.id);

    expect(getTask(t.id)!.status).toBe('cancelled');
    expect(abortSpy).toHaveBeenCalledWith('sess-cex');
  });

  it('K7-4: transition 到无关状态（如 assigned）不触发中断', async () => {
    const t = insertTask({ workspaceId: 'ws1', title: '无关联', creatorUserId: '@owner:home' });
    const handler = handlers.get('task:transition')!;
    await handler(null, t.id, 'assigned');
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it('K7-4: 无执行会话的任务取消（未启动的 assigned）→ 不触发中断', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: '未启动',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-x',
      status: 'assigned',
    });
    const handler = handlers.get('task:cancel')!;
    await handler(null, t.id);
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it('K7-5: task:resume → paused 转 in_progress + kickoff 重注入执行会话', async () => {
    const taskId = seedPausedTask('sess-res');
    // 局部拦截 sendUserMessage 真身（内部是 insertMessage + 接待路由重链路，
    // 本用例只断言 kickoff 注入参数）；其余用例保持 spy 直通
    sendUserMessageSpy.mockResolvedValue({ ok: true } as never);

    const handler = handlers.get('task:resume')!;
    const row = await handler(null, taskId);

    expect(row.status).toBe('in_progress');
    expect(sendUserMessageSpy).toHaveBeenCalledTimes(1);
    const kickoff = sendUserMessageSpy.mock.calls[0]![0] as {
      sessionId: string;
      body: string;
      mentionedInstanceIds?: string[];
      systemKickoff?: boolean;
    };
    expect(kickoff.sessionId).toBe('sess-res');
    expect(kickoff.body).toContain(taskId);
    expect(kickoff.mentionedInstanceIds).toEqual(['inst-x']);
    expect(kickoff.systemKickoff).toBe(true);
  });

  it('K7-5: 非 paused 任务 resume → 状态机拦截抛错', async () => {
    const t = insertTask({ workspaceId: 'ws1', title: 'draft 任务', creatorUserId: '@owner:home' });
    const handler = handlers.get('task:resume')!;
    await expect(handler(null, t.id)).rejects.toThrow();
    expect(sendUserMessageSpy).not.toHaveBeenCalled();
  });
});

// K9：手动启动（task:start）与 executor 自动放行必须等价——startTask 只建
// 会话/转状态，kickoff 消息注入才是驱动 agent 开始执行的指令。旧实现
// task:start 漏了这半步：用户点「启动」→ 新会话创建 + in_progress，
// 但会话里没有任何消息 → agent 无事可做（用户主机报告：指派 agent/团队/
// 会话后点启动，只建会话不执行）。
describe('task:start 手动启动 kickoff 注入（K9）', () => {
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

  it('K9: 手动启动 assigned 任务 → 真实转 in_progress + kickoff 注入执行会话', async () => {
    seedAgentMember('inst-k9');
    const t = insertTask({
      workspaceId: 'ws1',
      title: '手动启动任务',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-k9',
      status: 'assigned',
    });
    sendUserMessageSpy.mockResolvedValue({ ok: true } as never);

    const handler = handlers.get('task:start')!;
    const result = await handler(null, t.id, {});

    expect(getTask(t.id)!.status).toBe('in_progress');
    expect(result.executionSessionId).toBeTruthy();
    expect(sendUserMessageSpy).toHaveBeenCalledTimes(1);
    const kickoff = sendUserMessageSpy.mock.calls[0]![0] as {
      sessionId: string;
      body: string;
      mentionedInstanceIds?: string[];
      systemKickoff?: boolean;
    };
    expect(kickoff.sessionId).toBe(result.executionSessionId);
    expect(kickoff.body).toContain(t.id);
    expect(kickoff.mentionedInstanceIds).toEqual(['inst-k9']);
    expect(kickoff.systemKickoff).toBe(true);
  });

  it('K9: 团队目标任务 → kickoff 无 mention（leader 接待路由）', async () => {
    seedAgentMember('inst-k9-leader');
    getDb()
      .prepare(
        `INSERT INTO teams (id, workspace_id, name, leader_instance_id) VALUES ('team-k9', 'ws1', '研发组', 'inst-k9-leader')`,
      )
      .run();
    const t = insertTask({
      workspaceId: 'ws1',
      title: '团队启动任务',
      creatorUserId: '@owner:home',
      targetTeamId: 'team-k9',
      status: 'assigned',
    });
    sendUserMessageSpy.mockResolvedValue({ ok: true } as never);

    const handler = handlers.get('task:start')!;
    await handler(null, t.id, {});

    expect(sendUserMessageSpy).toHaveBeenCalledTimes(1);
    const kickoff = sendUserMessageSpy.mock.calls[0]![0] as {
      mentionedInstanceIds?: string[];
    };
    expect(kickoff.mentionedInstanceIds).toBeUndefined();
  });

  it('K9: 已 in_progress 幂等返回 → 不重复注入 kickoff', async () => {
    seedAgentMember('inst-k9-idem');
    const t = insertTask({
      workspaceId: 'ws1',
      title: '幂等启动',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-k9-idem',
      status: 'assigned',
    });
    sendUserMessageSpy.mockResolvedValue({ ok: true } as never);

    const handler = handlers.get('task:start')!;
    await handler(null, t.id, {}); // 首次启动：注入一次
    await handler(null, t.id, {}); // 幂等返回：不再注入

    expect(sendUserMessageSpy).toHaveBeenCalledTimes(1);
  });

  // K10 回归锁：主进程新建执行会话（createdNewRoom）必须通知 renderer 刷新
  // 会话列表——sessions 列表只在进 IM 视图时拉取，定时任务到点自动放行建的
  // 新会话对停留在 IM 视图的用户不可见（切走再切回才出现——用户主机报告）
  it('K10: task:start 新建会话 → 通知会话列表刷新；复用/幂等路径不通知', async () => {
    seedAgentMember('inst-k10');
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'K10 任务',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-k10',
      status: 'assigned',
    });
    sendUserMessageSpy.mockResolvedValue({ ok: true } as never);

    const handler = handlers.get('task:start')!;
    await handler(null, t.id, {}); // 新建执行会话路径
    expect(sessionListChangedSpy).toHaveBeenCalledTimes(1);

    await handler(null, t.id, {}); // 幂等（复用已锁定会话）
    expect(sessionListChangedSpy).toHaveBeenCalledTimes(1); // 不重复通知
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

  // C1 修复 1：create 入口是定时管线起点——带 scheduledAt 必须落 pending
  // （spec §4.4「pending = 定时未到」），否则 scheduler 永远扫不到（旧实现恒落 draft）
  it('task:create 带 scheduledAt → 落 pending（定时管线入口）', async () => {
    const handler = handlers.get('task:create')!;
    const created = await handler(null, {
      workspaceId: 'ws1',
      title: '定时任务',
      creatorUserId: 'owner',
      assigneeAgentId: 'inst1',
      scheduledAt: Date.now() + 60_000,
    });
    expect(created.status).toBe('pending');
  });

  // K1 回归锁（P0 修复）：带委派目标但无 scheduledAt 的任务旧实现落 draft，
  // 而 scheduler 只消费 pending、executor 只消费 assigned——draft 任务被两个
  // 调度器同时无视，指派了 agent 也永远不会自动执行（用户主机验收报告）。
  // 新行为：有目标 + 无计划时间 → 直接入队 assigned，executor 立即评估放行。
  it('K1: task:create 带 assigneeAgentId 不带 scheduledAt → 落 assigned（立即入队）', async () => {
    const handler = handlers.get('task:create')!;
    const created = await handler(null, {
      workspaceId: 'ws1',
      title: '指派任务',
      creatorUserId: 'owner',
      assigneeAgentId: 'inst1',
    });
    expect(created.status).toBe('assigned');
  });

  it('K1: task:create 带 targetTeamId 不带 scheduledAt → 落 assigned', async () => {
    const handler = handlers.get('task:create')!;
    const created = await handler(null, {
      workspaceId: 'ws1',
      title: '团队任务',
      creatorUserId: 'owner',
      targetTeamId: 'team1',
    });
    expect(created.status).toBe('assigned');
  });

  it('K1: task:create 带 targetSessionId 不带 scheduledAt → 落 assigned', async () => {
    const handler = handlers.get('task:create')!;
    const created = await handler(null, {
      workspaceId: 'ws1',
      title: '会话任务',
      creatorUserId: 'owner',
      targetSessionId: 'sess-1',
    });
    expect(created.status).toBe('assigned');
  });

  // 无目标 = 用户暂存草稿（「不指派」语义），保持 draft 等待手动编辑指派
  it('K1: task:create 无委派目标不带 scheduledAt → 落 draft（草稿暂存）', async () => {
    const handler = handlers.get('task:create')!;
    const created = await handler(null, {
      workspaceId: 'ws1',
      title: '手动任务',
      creatorUserId: 'owner',
    });
    expect(created.status).toBe('draft');
  });

  // 无目标 + 带 scheduledAt：维持 C1 语义落 pending（到点 scheduler 因无目标
  // 不升级，用户可手动启动——pending 允许 startTask）
  it('K1: task:create 无委派目标但带 scheduledAt → 落 pending（C1 语义保持）', async () => {
    const handler = handlers.get('task:create')!;
    const created = await handler(null, {
      workspaceId: 'ws1',
      title: '定时手动任务',
      creatorUserId: 'owner',
      scheduledAt: Date.now() + 60_000,
    });
    expect(created.status).toBe('pending');
  });
});
