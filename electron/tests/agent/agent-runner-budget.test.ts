// electron/tests/agent/agent-runner-budget.test.ts
//
// v2.2 bug 修复回归锁：会话工具调用次数设置接入 task-driven 派发链。
// 根因：resolveMaxToolCalls 此前零生产调用者——sessions.settings_json /
// global_settings 的 maxToolCalls 从未注入 AGENT_CONFIG（buildSpawnOpts 不含
// 该字段，parseConfig 缺省恒 10），修改会话工具上限后任何会话都不生效。
//
// 修复契约：AgentRunner.executeTask 每条消息派发时按 executionSessionId
// 现解析（session 覆盖 → global 默认），经 task-config IPC 字段 maxToolCalls
// 下发子进程——修改设置后下一条消息即生效，不受 warm runtime 定型影响。
// 解析失败（settings_json 损坏等）不阻塞消息派发（回退子进程默认）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentRunner } from '../../src/main/agent/agent-runner';
import { WarmPool } from '../../src/main/agent/warm-pool';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertSession,
  updateSessionSettings,
} from '../../src/main/storage/sessions/repo';
import { updateGlobalSettings } from '../../src/main/settings/crud';
import type { ChildProcess } from 'node:child_process';

vi.mock('../../src/main/memory/extraction', () => ({
  scheduleExtraction: vi.fn(),
}));

function mkMockChild(): ChildProcess & {
  kill: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
} {
  return {
    pid: 12345,
    on: vi.fn(),
    off: vi.fn(),
    send: vi.fn(() => true),
    kill: vi.fn(),
    connected: true,
    exitCode: null,
  } as unknown as ChildProcess & {
    kill: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };
}

/** 从 child.send 调用记录里取最新一条 task-config 载荷（每条消息各派发一次） */
function taskConfigPayload(child: ChildProcess): Record<string, unknown> {
  const calls = (child.send as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const payloads = calls
    .map((c) => c[0])
    .filter(
      (m) =>
        typeof m === 'object' && m !== null && (m as { type?: string }).type === 'task-config',
    );
  const payload = payloads[payloads.length - 1];
  if (!payload) throw new Error('task-config 未发送');
  return payload as Record<string, unknown>;
}

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-runner-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

function setupDb(): void {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`,
    )
    .run('ws1', 'Test', '/tmp', '@owner:home');
}

async function mkRunner(): Promise<{ runner: AgentRunner; child: ChildProcess }> {
  const child = mkMockChild();
  const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
  await warmPool.warm('inst1');
  return {
    runner: new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-x1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    }),
    child,
  };
}

describe('AgentRunner 会话工具预算接线（v2.2 修复）', () => {
  beforeEach(() => {
    setupDb();
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('会话级 maxToolCalls=25 → task-config 携带 maxToolCalls: 25', async () => {
    const session = insertSession({ workspaceId: 'ws1', title: '预算会话' });
    updateSessionSettings(session.id, { maxToolCalls: 25 });
    const { runner, child } = await mkRunner();

    await runner.executeTask({
      taskId: null,
      executionSessionId: session.id,
      body: 'hi',
      streamSessionId: 'ss-budget-1',
    });

    expect(taskConfigPayload(child)).toMatchObject({
      type: 'task-config',
      maxToolCalls: 25,
      streamSessionId: 'ss-budget-1',
    });
  });

  it('会话未设置（null）→ 回退全局 maxToolCalls=7', async () => {
    const session = insertSession({ workspaceId: 'ws1', title: '继承会话' });
    updateGlobalSettings({ maxToolCalls: 7 });
    const { runner, child } = await mkRunner();

    await runner.executeTask({
      taskId: null,
      executionSessionId: session.id,
      body: 'hi',
      streamSessionId: 'ss-budget-2',
    });

    expect(taskConfigPayload(child)).toMatchObject({ maxToolCalls: 7 });
  });

  it('修改会话预算后下一条消息即生效（同 runner 不重 spawn）', async () => {
    const session = insertSession({ workspaceId: 'ws1', title: '改动会话' });
    const { runner, child } = await mkRunner();

    updateSessionSettings(session.id, { maxToolCalls: 3 });
    await runner.executeTask({
      taskId: null,
      executionSessionId: session.id,
      body: 'first',
      streamSessionId: 'ss-budget-3a',
    });
    expect(taskConfigPayload(child)).toMatchObject({ maxToolCalls: 3 });

    updateSessionSettings(session.id, { maxToolCalls: 40 });
    await runner.executeTask({
      taskId: null,
      executionSessionId: session.id,
      body: 'second',
      streamSessionId: 'ss-budget-3b',
    });
    expect(taskConfigPayload(child)).toMatchObject({
      maxToolCalls: 40,
      streamSessionId: 'ss-budget-3b',
    });
  });

  it('settings_json 损坏 → 不携带 maxToolCalls 字段（回退子进程默认）且派发不抛错', async () => {
    const session = insertSession({ workspaceId: 'ws1', title: '损坏会话' });
    getDb()
      .prepare('UPDATE sessions SET settings_json = ? WHERE id = ?')
      .run('{not-valid-json', session.id);
    const { runner, child } = await mkRunner();

    await expect(
      runner.executeTask({
        taskId: null,
        executionSessionId: session.id,
        body: 'hi',
        streamSessionId: 'ss-budget-4',
      }),
    ).resolves.toMatchObject({ streamSessionId: 'ss-budget-4' });

    const payload = taskConfigPayload(child);
    expect(payload).not.toHaveProperty('maxToolCalls');
  });
});
