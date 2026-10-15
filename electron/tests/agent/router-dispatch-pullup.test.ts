// electron/tests/agent/router-dispatch-pullup.test.ts
//
// 回归锁（验收缺陷 D1 · P0，2026-10-15 团队协作全链路验收）：
// 团队**首次** dispatch 目标成员 runtime 未拉起——routeDispatch 对「有效成员但
// 无 runner」只 warn 一条然后 return（router-service.ts 的 runners.get 未命中
// 分支），既不调 RouterServiceOpts.ensureRunner（生产接线 = start-chain 的
// ensureMemberRuntime，router-bootstrap.ts 已注入），也无错误上报。子任务 chip
// 永停「已派出，等待启动…」，主流程死等，用户只能重启 App 绕行（重启后 boot 链
// 预拉起全部成员 runtime，dispatch 即通——对照证明缺口仅在 dispatch 时点）。
//
// 预期语义（spec v25 §4.6「目标成员离线时自动拉起」+ RouterServiceOpts.ensureRunner
// 字段注释「runner 缺失时先经此回调走 agent start 链，完成后再派发」）：
// routeDispatch 与 routeUserChat 同语义——目标 runner 缺失时先经 ensureRunner
// 拉起，成功后照常 executeTask 派发 dispatch 任务。
//
// 修复状态：routeDispatch 已补 ensureRunner 拉起链 + 失败回执（PM 经
// notifyTaskReply 收 failed，等待死锁打破）——本 spec 三例全绿为修复闭环判据；
// 修复前用例 1/2 红（ensureRunner 从未被调）。
// 证据报告：.omo/qa-reports/2026-10-15-team-appdev-aieval/report.md（D1）
//
// 运行：cd electron && npx pnpm@9.0.0 vitest run tests/agent/router-dispatch-pullup.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RouterService } from '../../src/main/agent/router-service';
import { __resetDispatchRegistryForTest } from '../../src/main/agent/dispatch-registry';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import type { AgentRunner } from '../../src/main/agent/agent-runner';

// 与 router-service.test.ts 同构的临时库 fixture：PM（inst-pm）与 sub（inst-sub）
// 均为 ws 有效成员 + '!room:home' 会话在场——sender '@pm:home' 反查 inst-pm 与
// dispatch_from 一致（R2 fail-closed 校验的 ok 路径），被测缺口纯粹是「成员有效
// 但 runtime 未拉起」。
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-router-dispatch-pullup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`).run();
  for (const inst of ['inst-pm', 'inst-sub']) {
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
          default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
    ).run(inst, inst, inst);
    db.prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES (?, 'ws', ?, ?)`,
    ).run(inst, inst, inst === 'inst-pm' ? '@pm:home' : '@sub:home');
  }
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, title, title_auto, kind, settings_json, created_at, updated_at)
     VALUES ('!room:home', 'ws', 'T', 0, 'chat', NULL, ?, ?)`,
  ).run(Date.now(), Date.now());
  __resetDispatchRegistryForTest();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 构造 mock Matrix event（与 router-service.test.ts 的 mkMockEvent 同形状子集） */
function mkMockEvent(
  type: string,
  content: Record<string, unknown>,
  sender = '@user:home',
  roomId = '!room:home',
) {
  return {
    getType: () => type,
    getContent: () => content,
    getSender: () => sender,
    getRoomId: () => roomId,
    getId: () => '$evt:home',
    getTs: () => Date.now(),
    isRedacted: () => false,
  } as never;
}

/** 构造一条 PM → sub 的 dispatch 事件（dispatch_to 即 assignmentId，v2 Task 10 契约） */
function mkDispatch(taskId: string) {
  return mkMockEvent(
    'io.momo-studio.dispatch',
    {
      body: '写登录页',
      task_id: taskId,
      dispatch_from: 'inst-pm',
      dispatch_to: 'inst-sub',
    },
    '@pm:home',
  );
}

describe('routeDispatch 目标成员无 runner → 自动拉起（D1 回归锁）', () => {
  it('目标为有效成员但 runner 缺失 → 经 ensureRunner 拉起后照常派发（现状红：D1 死等根因）', async () => {
    const subRunner = { executeTask: vi.fn().mockResolvedValue({ streamSessionId: 'ss-pull' }) };
    const runners = new Map<string, AgentRunner>();
    // 模拟 start 链成功语义：ensureMemberRuntime 完成后 runner 注册进共享 Map
    //（生产接线中 RouterService 持有 agentRunners Map 引用，行为一致）
    const ensureRunner = vi.fn().mockImplementation(async (assignmentId: string) => {
      if (assignmentId === 'inst-sub') {
        runners.set('inst-sub', subRunner as unknown as AgentRunner);
      }
    });
    const svc = new RouterService({ runners, ensureRunner });

    await svc.routeEvent(mkDispatch('task-d1-pull'), 'inst-pm', '!room:home', 'inst-sub');

    // 主断言：不允许「warn 后静默丢弃」——必须先尝试拉起
    expect(ensureRunner).toHaveBeenCalledWith('inst-sub');
    // 拉起成功 → dispatch 任务照常派发到子 agent（dispatchContext 完整）
    expect(subRunner.executeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-d1-pull',
        executionSessionId: '!room:home',
        dispatchContext: expect.objectContaining({
          fromAssignmentId: 'inst-pm',
          task_id: 'task-d1-pull',
        }),
      }),
    );
  });

  it('拉起失败 → 不抛错、不派发、PM 收到 failed 回执（不死等）', async () => {
    const pmRunner = { executeTask: vi.fn(), notifyTaskReply: vi.fn() };
    const runners = new Map<string, AgentRunner>([
      ['inst-pm', pmRunner as unknown as AgentRunner],
    ]);
    const ensureRunner = vi.fn().mockRejectedValue(new Error('供应商 API key 丢失，请检查设置 → 供应商'));
    const svc = new RouterService({ runners, ensureRunner });

    // 路由层契约：拉起失败不得把 reject 抛给事件桥（fire-and-forget 语义）
    await expect(
      svc.routeEvent(mkDispatch('task-d1-fail'), 'inst-pm', '!room:home', 'inst-sub'),
    ).resolves.toBeUndefined();

    // 拉起尝试必须发生（现状红：直接 warn 跳过，ensureRunner 从未被调）
    expect(ensureRunner).toHaveBeenCalledWith('inst-sub');
    // 无 runner 注册 → 子任务不派发
    expect(runners.has('inst-sub')).toBe(false);
    // PM 收到 failed 回执（routeTaskReply 同款通道）——等待方被唤醒，死锁打破
    expect(pmRunner.notifyTaskReply).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-d1-fail',
        status: 'failed',
      }),
    );
    // PM 自身不被误派发子任务
    expect(pmRunner.executeTask).not.toHaveBeenCalled();
  });

  it('runner 已在位 → 直接派发，不触发 ensureRunner（避免无效拉起，现状绿）', async () => {
    const subRunner = { executeTask: vi.fn().mockResolvedValue({ streamSessionId: 'ss-hit' }) };
    const runners = new Map<string, AgentRunner>([
      ['inst-sub', subRunner as unknown as AgentRunner],
    ]);
    const ensureRunner = vi.fn();
    const svc = new RouterService({ runners, ensureRunner });

    await svc.routeEvent(mkDispatch('task-d1-hit'), 'inst-pm', '!room:home', 'inst-sub');

    expect(ensureRunner).not.toHaveBeenCalled();
    expect(subRunner.executeTask).toHaveBeenCalledTimes(1);
    expect(subRunner.executeTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-d1-hit' }),
    );
  });
});
