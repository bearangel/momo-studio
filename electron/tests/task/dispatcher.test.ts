// electron/tests/task/dispatcher.test.ts
//
// TaskDispatcher pickup 决策 + 三层并发控制测试（D 子系统 D5）。
//
// 测试覆盖（7 个用例）：
//   1. pickup 成功（per-agent / 全局 / provider 三层均通过）
//   2. per-agent 并发已满 → 短路不 pickup
//   3. 全局并发已满 → 短路不 pickup
//   4. provider 限流 → 短路不 pickup
//   5. 无 assigned 任务 → 不 pickup
//   6. 未到 scheduled_at → 不 pickup
//   7. scanAll 遍历所有 runner 触发 pickup
//
// 测试隔离：tmp 目录 + closeDb + AP_USER_DATA_DIR 重置。
// tasks 表仅有 workspace_id 的 FK，无 agent_definitions FK，故不必 seed def。
//
// mock AgentRunner：对象字面量 + vi.fn()，用 `as unknown as AgentRunner` 跨过私有字段类型校验。
// mock ProviderTokenBucket：用真实实现（D2 已测），通过预 record 触发限流。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, transitionTaskStatus } from '../../src/main/storage/tasks/repo';
import { TaskDispatcher } from '../../src/main/task/dispatcher';
import { ProviderTokenBucket } from '../../src/main/agent/llm/token-bucket';
import type { AgentRunner } from '../../src/main/agent/agent-runner';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-disp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // seed workspace（tasks 表 FK 要求）
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, directory_path, team_session_id, owner_id) VALUES (?, ?, ?, ?, ?)`,
    )
    .run('ws1', 'Test', '/tmp', '!space:home', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

interface MkOpts {
  globalMax?: number;
  maxConcurrent?: number;
  providerMax?: number;
  /** 构造后预消费多少次 provider 配额（用于触发 RPM 限流） */
  preConsume?: number;
}

function mkDispatcher(opts: MkOpts): {
  mockRunner: {
    activeTaskCount: ReturnType<typeof vi.fn>;
    executeTask: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  bucket: ProviderTokenBucket;
  dispatcher: TaskDispatcher;
} {
  const bucket = new ProviderTokenBucket({ maxRpm: opts.providerMax ?? 100 });
  // 预消费：模拟其他任务已用掉部分 RPM 额度
  for (let i = 0; i < (opts.preConsume ?? 0); i++) {
    bucket.record(100);
  }
  const buckets = new Map([['provider-1', bucket]]);
  const runners = new Map<string, AgentRunner>();
  const mockRunner = {
    activeTaskCount: vi.fn().mockReturnValue(0),
    executeTask: vi.fn().mockResolvedValue({ streamSessionId: 'ss-1' }),
    destroy: vi.fn(),
  };
  runners.set('inst1', mockRunner as unknown as AgentRunner);

  const dispatcher = new TaskDispatcher({
    runners,
    buckets,
    getAgentAssignment: (id) =>
      id === 'inst1'
        ? {
            agentDefinitionId: 'def1',
            modelProviderId: 'provider-1',
            maxConcurrentTasks: opts.maxConcurrent ?? 1,
          }
        : null,
    getGlobalMax: () => opts.globalMax ?? 3,
    now: () => 1000,
  });

  return { mockRunner, bucket, dispatcher };
}

describe('TaskDispatcher', () => {
  it('per-agent 并发未满 + 全局未满 + provider 未限流 → pickup', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst1',
    });
    transitionTaskStatus(t.id, 'assigned');
    const { mockRunner, dispatcher } = mkDispatcher({});
    const picked = await dispatcher.tryPickup('inst1');
    expect(picked).toBe(true);
    expect(mockRunner.executeTask).toHaveBeenCalled();
  });

  it('per-agent 并发已满 → 不 pickup', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst1',
    });
    transitionTaskStatus(t.id, 'assigned');
    const { mockRunner, dispatcher } = mkDispatcher({ maxConcurrent: 1 });
    mockRunner.activeTaskCount.mockReturnValue(1); // 已满
    const picked = await dispatcher.tryPickup('inst1');
    expect(picked).toBe(false);
    expect(mockRunner.executeTask).not.toHaveBeenCalled();
  });

  it('全局并发已满 → 不 pickup', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst1',
    });
    transitionTaskStatus(t.id, 'assigned');
    const { dispatcher } = mkDispatcher({ globalMax: 0 });
    const picked = await dispatcher.tryPickup('inst1');
    expect(picked).toBe(false);
  });

  it('provider 限流 → 不 pickup', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst1',
    });
    transitionTaskStatus(t.id, 'assigned');
    // maxRpm=1 + 预消费 1 次 → canConsume 返回 false
    // （注：D2 实现中 maxRpm=0 视为"不限"，必须用 maxRpm=1 + record 触发限流）
    const { mockRunner, dispatcher } = mkDispatcher({ providerMax: 1, preConsume: 1 });
    const picked = await dispatcher.tryPickup('inst1');
    expect(picked).toBe(false);
    expect(mockRunner.executeTask).not.toHaveBeenCalled();
  });

  it('无 assigned 任务 → 不 pickup', async () => {
    const { dispatcher } = mkDispatcher({});
    const picked = await dispatcher.tryPickup('inst1');
    expect(picked).toBe(false);
  });

  it('未到 scheduled_at → 不 pickup', async () => {
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst1',
      scheduledAt: 2000, // dispatcher now()=1000，未到
    });
    transitionTaskStatus(t.id, 'assigned');
    const { mockRunner, dispatcher } = mkDispatcher({});
    const picked = await dispatcher.tryPickup('inst1');
    expect(picked).toBe(false);
    expect(mockRunner.executeTask).not.toHaveBeenCalled();
  });

  it('scanAll 遍历所有 runner，触发 pickup', async () => {
    const t1 = insertTask({
      workspaceId: 'ws1',
      title: 'T1',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst1',
    });
    transitionTaskStatus(t1.id, 'assigned');
    const { mockRunner, dispatcher } = mkDispatcher({});
    await dispatcher.scanAll();
    expect(mockRunner.executeTask).toHaveBeenCalled();
  });
});
