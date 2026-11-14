// electron/tests/agent/agent-runner-quota.test.ts
//
// 配额受限自动续跑（2026-11-04 生产事故）：AgentRunner C1 终态映射的配额分支。
// 链路：子 agent runChatLoop 抛 429 配额错误 → task-end(error=错误文本) →
// transitionTaskTerminal。dispatch 簿记行的配额失败不落终态 failed——改排
// assigned + scheduled_at 自动续跑；与 dispatch-task-ledger 的 task_reply 入口
// 共用调度单点（幂等：先到者调度，后到者按行状态 no-op）。
// ChildProcess 用 mock（与 agent-runner.test.ts 同模式，避免真实 fork）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentRunner } from '../../src/main/agent/agent-runner';
import { WarmPool } from '../../src/main/agent/warm-pool';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getTask, insertTask } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { startRun, submitRun, acceptTask } from '../../src/main/task/lifecycle-runs';
import type { ChildProcess } from 'node:child_process';

// 与 agent-runner.test.ts 同法：extraction 最小 mock，防真实提取链跨模块写测试库
vi.mock('../../src/main/memory/extraction', () => ({
  scheduleExtraction: vi.fn(),
}));

const tmpRoot = path.join(os.tmpdir(), `ap-runner-quota-${Date.now()}-${Math.random().toString(36).slice(2)}`);
fs.mkdirSync(tmpRoot, { recursive: true });
process.env.AP_USER_DATA_DIR = tmpRoot;

const TASK_ID = 'q-chain-r1';
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

/** 事故同构 429 配额错误文本（无重置句 → 退避模式，断言用相对时刻） */
function quotaErrorText(): string {
  return (
    '模型服务连接失败：服务繁忙（限流），请稍后重试（已自动重试 5 次）。本轮未完成，发送「继续」可从断点恢复' +
    '\n||details||\n' +
    'HTTP 429 {"error":{"code":"1308","message":"已达到 5 小时的使用上限，请稍后使用。"}}'
  );
}

/** 建 dispatch 簿记行（v2 生产形态：行 + run #1——ledgerInsertDispatch 同款） */
function seedDispatchTask(): void {
  insertTask({
    id: TASK_ID,
    origin: 'dispatch',
    workspaceId: 'ws',
    title: '写注册页组件',
    status: 'in_progress',
    creatorUserId: 'agent:inst-pm',
    assigneeAgentId: 'inst-sub',
    executionSessionId: sessionId,
    sourceSessionId: sessionId,
    startedAt: Date.now(),
  });
  startRun(TASK_ID, { trigger: 'initial', executionSessionId: sessionId });
}

function mkMockChild(): ChildProcess {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    pid: 23456,
    on: vi.fn((event: string, h: (...args: unknown[]) => void) => {
      handlers[event] = h;
    }),
    off: vi.fn(),
    send: vi.fn((msg: unknown) => {
      if (
        typeof msg === 'object' &&
        msg !== null &&
        (msg as { type?: string }).type === 'task-config'
      ) {
        setTimeout(
          () =>
            handlers['message']?.({
              type: 'task-ack',
              streamSessionId: (msg as { streamSessionId: string }).streamSessionId,
            }),
          0,
        );
      }
      return true;
    }),
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

function mkRunner(pool: WarmPool): AgentRunner {
  return new AgentRunner({
    agentAssignmentId: 'inst-sub',
    agentUserId: 'agent-sub',
    workspaceId: 'ws',
    warmPool: pool,
    taskEndGraceMs: 10_000,
  });
}

async function executeOnRunner(): Promise<ChildProcess> {
  const child = mkMockChild();
  const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
  await warmPool.warm('inst-sub');
  const runner = mkRunner(warmPool);
  await runner.executeTask({
    taskId: TASK_ID,
    executionSessionId: sessionId,
    body: 'x',
    streamSessionId: 'ss-quota',
  });
  return child;
}

function quotaNotices(): Array<{ body: string }> {
  return getDb()
    .prepare(
      `SELECT body FROM messages WHERE session_id = ? AND task_id = ? AND sender = 'system' AND body LIKE '【配额受限自动续跑】%'`,
    )
    .all(sessionId, TASK_ID) as Array<{ body: string }>;
}

describe('AgentRunner task-end 配额自动续跑（C1 配额分支）', () => {
  beforeEach(() => {
    setupDb();
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('task-end 携带 429 配额错误 → 不落 failed，排 assigned + scheduled_at≈now+5min + 计数 1 + 一条通知', async () => {
    seedDispatchTask();
    const child = await executeOnRunner();
    const before = Date.now();

    getMessageHandler(child)({ type: 'task-end', streamSessionId: 'ss-quota', taskId: TASK_ID, error: quotaErrorText() });

    const row = getTask(TASK_ID)!;
    expect(row.status, '配额失败 ≠ 终态——等待自动续跑').toBe('assigned');
    expect(Math.abs(row.scheduledAt! - (before + 5 * 60_000))).toBeLessThan(15_000);
    expect(row.errorMessage).toContain('使用上限');
    expect(child.kill).toHaveBeenCalled(); // 收尾链照常（仅终态转换被替换）
    expect(quotaNotices()).toHaveLength(1);
  });

  it('非配额错误（连接中断）→ 行为不变：failed + errorMessage + 无通知', async () => {
    seedDispatchTask();
    getDb()
      .prepare(`UPDATE tasks SET routing_json = ? WHERE id = ?`)
      .run(JSON.stringify({ quotaRetryCount: 1 }), TASK_ID);
    const child = await executeOnRunner();

    getMessageHandler(child)({ type: 'task-end', streamSessionId: 'ss-quota', taskId: TASK_ID, error: '连接中断：terminated' });

    const row = getTask(TASK_ID)!;
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toContain('连接中断');
    expect(quotaNotices()).toHaveLength(0);
    const routingJson = (
      getDb().prepare('SELECT routing_json FROM tasks WHERE id = ?').get(TASK_ID) as { routing_json: string | null }
    ).routing_json;
    expect(routingJson === null || !Object.prototype.hasOwnProperty.call(JSON.parse(routingJson), 'quotaRetryCount'), '非配额失败清计数').toBe(true);
  });

  it('行已排队（task_reply 链路先到）→ 迟到 task-end 不覆盖排队行、不重复通知', async () => {
    seedDispatchTask();
    const child = await executeOnRunner();
    // 先经 ledger 入口调度（task_reply 先到的时序）——dispatch-task-ledger 引真实实现
    const { ledgerSettleDispatch } = await import('../../src/main/agent/dispatch-task-ledger');
    ledgerSettleDispatch(TASK_ID, 'failed', quotaErrorText());
    const scheduled = getTask(TASK_ID)!.scheduledAt;

    getMessageHandler(child)({ type: 'task-end', streamSessionId: 'ss-quota', taskId: TASK_ID, error: quotaErrorText() });

    const row = getTask(TASK_ID)!;
    expect(row.status).toBe('assigned');
    expect(row.scheduledAt).toBe(scheduled);
    expect(quotaNotices(), '两个 settle 入口只产一条通知').toHaveLength(1);
  });

  it('计数已 3（预算耗尽）→ task-end 配额错误回落终态 failed', async () => {
    seedDispatchTask();
    getDb()
      .prepare(`UPDATE tasks SET routing_json = ? WHERE id = ?`)
      .run(JSON.stringify({ quotaRetryCount: 3 }), TASK_ID);
    const child = await executeOnRunner();

    getMessageHandler(child)({ type: 'task-end', streamSessionId: 'ss-quota', taskId: TASK_ID, error: quotaErrorText() });

    expect(getTask(TASK_ID)!.status, '第 4 次配额失败——人工介入').toBe('failed');
    expect(quotaNotices()).toHaveLength(0);
  });

  it('续跑轮经工具侧完成（submit_task 先行转终态）→ 迟到 task-end 清计数不改状态', async () => {
    seedDispatchTask();
    getDb()
      .prepare(`UPDATE tasks SET routing_json = ? WHERE id = ?`)
      .run(JSON.stringify({ quotaRetryCount: 1 }), TASK_ID);
    const child = await executeOnRunner();
    // 续跑轮 agent 调 submit_task + 验收通过（v2 两段式完成链）先行落终态
    await submitRun(TASK_ID, { summary: '续跑轮交付' });
    await acceptTask(TASK_ID);
    expect(getTask(TASK_ID)!.status).toBe('completed');

    getMessageHandler(child)({ type: 'task-end', streamSessionId: 'ss-quota', taskId: TASK_ID, toolCallsUsed: 2 });

    expect(getTask(TASK_ID)!.status, '终态不被迟到 task-end 改写').toBe('completed');
    const raw = getDb()
      .prepare('SELECT routing_json FROM tasks WHERE id = ?')
      .get(TASK_ID) as { routing_json: string | null };
    expect(
      raw.routing_json === null || !Object.prototype.hasOwnProperty.call(JSON.parse(raw.routing_json), 'quotaRetryCount'),
      '成功结局清计数（防 followup 复用链 id 时计数串轮）',
    ).toBe(true);
  });
});
