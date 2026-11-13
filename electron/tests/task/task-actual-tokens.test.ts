// electron/tests/task/task-actual-tokens.test.ts
//
// R3 真实 token 遥测——tasks.actual_tokens 落库契约锁（2026-11-05）：
//   1. ledgerSettleDispatch（task_reply 入口）：终态 + usage → actual_tokens =
//      (existing ?? 0) + prompt + completion；无 usage → 保持 NULL
//   2. 配额续跑分支（QUOTA_LIMITED → assigned 非终态）：本轮 usage 同样累积
//      （run 的消耗是真实数据，与是否终态无关）
//   3. followup 复用（insert 复位 in_progress）后第二轮 settle → 跨轮累积
//   4. routing_json 保留：usage 写入不剥除 quotaRetryCount 等附加键（W3 契约）
//   5. AgentRunner task-end 入口：user 任务终态转换携带 usageTotal → 累积写；
//      缺席 → NULL；已终态（reply 先行）→ 不重复计数
//
// 真实 DB（沿 dispatch-task-ledger-quota.test.ts 形态）；AgentRunner ChildProcess
// mock（沿 agent-runner-quota.test.ts 形态）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';

vi.mock('../../src/main/memory/extraction', () => ({
  scheduleExtraction: vi.fn(),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getTask, insertTask, transitionTaskStatus } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import {
  ledgerInsertDispatch,
  ledgerSettleDispatch,
} from '../../src/main/agent/dispatch-task-ledger';
import { AgentRunner } from '../../src/main/agent/agent-runner';
import { WarmPool } from '../../src/main/agent/warm-pool';

const tmpRoot = path.join(os.tmpdir(), `ap-actual-tokens-${Date.now()}-${Math.random().toString(36).slice(2)}`);

let sessionId = '';

function setupDb(): void {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`,
  ).run();
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
        default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
     VALUES ('inst-sub', 'sub', 'sub', '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES ('inst-sub', 'ws', 'inst-sub', 'agent-sub')`,
  ).run();
  sessionId = insertSession({ workspaceId: 'ws', title: '协作', kind: 'chat' }).id;
}

// v2 语义：settle/task-end 的 completed 结局 = 验收已提交交付（合法边仅
// submitted → completed）——凡断言 completed 终态的用例，种子/复位后先推到
// submitted（模拟 run 已提交交付物），不弱化任何断言
function seedDispatchTask(id: string, status: 'in_progress' | 'submitted' = 'in_progress'): void {
  insertTask({
    id,
    origin: 'dispatch',
    workspaceId: 'ws',
    title: '子任务',
    status,
    creatorUserId: 'agent:inst-pm',
    assigneeAgentId: 'inst-sub',
    executionSessionId: sessionId,
    sourceSessionId: sessionId,
    startedAt: Date.now(),
  });
}

function seedUserTask(
  id: string,
  status: 'in_progress' | 'assigned' | 'submitted' = 'in_progress',
): void {
  insertTask({
    id,
    workspaceId: 'ws',
    title: '任务板任务',
    status,
    creatorUserId: 'u-1',
    executionSessionId: sessionId,
    startedAt: status === 'assigned' ? null : Date.now(),
  });
}

function quotaErrorText(): string {
  return (
    '模型服务连接失败：服务繁忙（限流），请稍后重试（已自动重试 5 次）。本轮未完成，发送「继续」可从断点恢复' +
    '\n||details||\n' +
    'HTTP 429 {"error":{"code":"1308","message":"已达到 5 小时的使用上限，请稍后使用。"}}'
  );
}

function rawRoutingJson(taskId: string): string | null {
  return (
    getDb().prepare('SELECT routing_json FROM tasks WHERE id = ?').get(taskId) as {
      routing_json: string | null;
    }
  ).routing_json;
}

beforeEach(() => {
  setupDb();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('ledgerSettleDispatch usage 累积（task_reply 入口）', () => {
  it('completed + usage → actual_tokens = prompt + completion；无 usage → NULL', () => {
    seedDispatchTask('tk-u1', 'submitted');
    seedDispatchTask('tk-u2', 'submitted');
    ledgerSettleDispatch('tk-u1', 'completed', undefined, { promptTokens: 100, completionTokens: 50 });
    ledgerSettleDispatch('tk-u2', 'completed');

    expect(getTask('tk-u1')!.actualTokens).toBe(150);
    expect(getTask('tk-u2')!.actualTokens, 'usage 缺席保持 NULL——不伪造 0').toBeNull();
  });

  it('failed 终态 + usage → 同样累积（失败回合消耗也是真实数据）', () => {
    seedDispatchTask('tk-u3');
    ledgerSettleDispatch('tk-u3', 'failed', '连接中断', { promptTokens: 30, completionTokens: 10 });
    expect(getTask('tk-u3')!.actualTokens).toBe(40);
  });

  it('followup 复位后第二轮 settle → 跨轮累积不覆盖', () => {
    seedDispatchTask('tk-u4', 'submitted');
    ledgerSettleDispatch('tk-u4', 'completed', undefined, { promptTokens: 100, completionTokens: 50 });
    expect(getTask('tk-u4')!.actualTokens).toBe(150);

    ledgerInsertDispatch({
      taskId: 'tk-u4',
      body: '追问轮',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId,
    });
    transitionTaskStatus('tk-u4', 'submitted');
    ledgerSettleDispatch('tk-u4', 'completed', undefined, { promptTokens: 60, completionTokens: 40 });
    expect(getTask('tk-u4')!.actualTokens, '读-改-写累积（150+100）').toBe(250);
  });

  it('配额续跑分支（assigned 非终态）→ 本轮 usage 仍累积', () => {
    seedDispatchTask('tk-u5');
    ledgerSettleDispatch('tk-u5', 'failed', quotaErrorText(), { promptTokens: 10, completionTokens: 5 });

    const row = getTask('tk-u5')!;
    expect(row.status, '配额失败不落终态').toBe('assigned');
    expect(row.actualTokens, '非终态但消耗已发生——照常累积').toBe(15);
    // 复位后续跑轮再次 settle：两轮消耗叠加
    ledgerInsertDispatch({
      taskId: 'tk-u5',
      body: '子任务',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId,
    });
    transitionTaskStatus('tk-u5', 'submitted');
    ledgerSettleDispatch('tk-u5', 'completed', undefined, { promptTokens: 1, completionTokens: 2 });
    expect(getTask('tk-u5')!.actualTokens).toBe(18);
  });

  it('配额排队分支的 usage 写入保留 routing_json 附加键（quotaRetryCount 不被剥除）', () => {
    seedDispatchTask('tk-u6');
    // 配额失败 → 排队分支写入 quotaRetryCount=1 到 routing_json；随后（本函数内）
    // usage 独立 updateTask 累积——只触碰 actualTokens，信封原样保留
    ledgerSettleDispatch('tk-u6', 'failed', quotaErrorText(), { promptTokens: 5, completionTokens: 5 });

    expect(getTask('tk-u6')!.actualTokens).toBe(10);
    const parsed = JSON.parse(rawRoutingJson('tk-u6') ?? '{}') as { quotaRetryCount?: unknown };
    expect(parsed.quotaRetryCount, 'usage 写入不剥除配额计数信封（W3 契约）').toBe(1);
  });

  it('幂等跳过（行已终态）→ 不重复计数', () => {
    seedDispatchTask('tk-u7', 'submitted');
    ledgerSettleDispatch('tk-u7', 'completed', undefined, { promptTokens: 100, completionTokens: 50 });
    ledgerSettleDispatch('tk-u7', 'completed', undefined, { promptTokens: 100, completionTokens: 50 });
    expect(getTask('tk-u7')!.actualTokens).toBe(150);
  });
});

describe('AgentRunner task-end usage 累积（task-driven 入口）', () => {
  function mkMockChild(): ChildProcess {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    return {
      pid: 23456,
      on: vi.fn((event: string, h: (...args: unknown[]) => void) => {
        handlers[event] = h;
      }),
      off: vi.fn(),
      send: vi.fn(() => true),
      kill: vi.fn(),
      connected: true,
      exitCode: null,
    } as unknown as ChildProcess;
  }

  function getMessageHandler(child: ChildProcess): (msg: unknown) => void {
    const onCalls = (child.on as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const handler = onCalls.find((c) => c[0] === 'message')?.[1] as
      | ((msg: unknown) => void)
      | undefined;
    if (!handler) throw new Error('message handler 未注册');
    return handler;
  }

  async function executeOnRunner(taskId: string): Promise<ChildProcess> {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst-sub');
    const runner = new AgentRunner({
      agentAssignmentId: 'inst-sub',
      agentUserId: 'agent-sub',
      workspaceId: 'ws',
      warmPool: warmPool,
      taskEndGraceMs: 10_000,
    });
    await runner.executeTask({
      taskId,
      executionSessionId: sessionId,
      body: 'x',
      streamSessionId: 'ss-usage',
    });
    return child;
  }

  it('user 任务 task-end 携带 usageTotal → completed 终态 + actual_tokens 累积', async () => {
    seedUserTask('T-u1', 'submitted');
    const child = await executeOnRunner('T-u1');

    getMessageHandler(child)({
      type: 'task-end',
      streamSessionId: 'ss-usage',
      taskId: 'T-u1',
      toolCallsUsed: 2,
      usageTotal: { promptTokens: 30, completionTokens: 40 },
    });

    const row = getTask('T-u1')!;
    expect(row.status).toBe('completed');
    expect(row.actualTokens).toBe(70);
  });

  it('task-end 无 usageTotal → actual_tokens 保持 NULL', async () => {
    seedUserTask('T-u2', 'submitted');
    const child = await executeOnRunner('T-u2');

    getMessageHandler(child)({
      type: 'task-end',
      streamSessionId: 'ss-usage',
      taskId: 'T-u2',
      toolCallsUsed: 1,
    });

    const row = getTask('T-u2')!;
    expect(row.status).toBe('completed');
    expect(row.actualTokens).toBeNull();
  });

  it('续跑/重跑累积：existing 100 + 本轮 70 → 170（读-改-写）', async () => {
    seedUserTask('T-u3', 'submitted');
    getDb().prepare(`UPDATE tasks SET actual_tokens = 100 WHERE id = 'T-u3'`).run();
    const child = await executeOnRunner('T-u3');

    getMessageHandler(child)({
      type: 'task-end',
      streamSessionId: 'ss-usage',
      taskId: 'T-u3',
      usageTotal: { promptTokens: 30, completionTokens: 40 },
    });

    expect(getTask('T-u3')!.actualTokens).toBe(170);
  });

  it('失败路径（error）同样写 usage + failed 终态', async () => {
    seedUserTask('T-u4');
    const child = await executeOnRunner('T-u4');

    getMessageHandler(child)({
      type: 'task-end',
      streamSessionId: 'ss-usage',
      taskId: 'T-u4',
      error: 'LLM 服务不可用',
      usageTotal: { promptTokens: 8, completionTokens: 2 },
    });

    const row = getTask('T-u4')!;
    expect(row.status).toBe('failed');
    expect(row.actualTokens).toBe(10);
  });

  it('malformed usageTotal（字符串/负数）→ 忽略不写、不抛错（IPC 漂移容忍）', async () => {
    seedUserTask('T-u5', 'submitted');
    seedUserTask('T-u6', 'submitted');
    const child5 = await executeOnRunner('T-u5');
    getMessageHandler(child5)({
      type: 'task-end',
      streamSessionId: 'ss-usage',
      taskId: 'T-u5',
      usageTotal: 'lots-of-tokens',
    });
    expect(getTask('T-u5')!.actualTokens).toBeNull();

    const child6 = await executeOnRunner('T-u6');
    getMessageHandler(child6)({
      type: 'task-end',
      streamSessionId: 'ss-usage',
      taskId: 'T-u6',
      usageTotal: { promptTokens: -5, completionTokens: 3 },
    });
    expect(getTask('T-u6')!.actualTokens).toBeNull();
  });

  it('dispatch 行已由 task_reply 先行终态结算 → 迟到 task-end 同值 usage 不重复计数', async () => {
    seedDispatchTask('q-dup-1', 'submitted');
    // task_reply 入口先行结算（runTaskChatLoop 先发 reply 后发 task-end 的生产时序）
    ledgerSettleDispatch('q-dup-1', 'completed', undefined, { promptTokens: 50, completionTokens: 50 });
    const child = await executeOnRunner('q-dup-1');

    getMessageHandler(child)({
      type: 'task-end',
      streamSessionId: 'ss-usage',
      taskId: 'q-dup-1',
      toolCallsUsed: 3,
      usageTotal: { promptTokens: 50, completionTokens: 50 },
    });

    const row = getTask('q-dup-1')!;
    expect(row.status).toBe('completed');
    expect(row.actualTokens, '同 run 双入口（reply + task-end）只计一次').toBe(100);
  });
});
