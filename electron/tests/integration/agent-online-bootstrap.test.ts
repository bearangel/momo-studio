// electron/tests/integration/agent-online-bootstrap.test.ts
//
// Task 5 集成测试：验证 initTaskDrivenRuntime 的 lastRunning 过滤逻辑。
//
// 背景（"all agents offline" bug 的核心层）：
//   app 启动时 initTaskDrivenRuntime 原仅过滤 enabled=1，未过滤 last_running=1。
//   这导致用户主动停止（last_running=0）的 agent 仍被注册 runner，而 UI 因
//   IPC isRunning 语义已改查 DB（Task 2）显示离线——runner 实际状态与 UI 不一致。
//
// 本测试断言：仅 task_driven=1 AND enabled=1 AND last_running=1 的 assignment
//   被 createTaskDrivenRuntime 处理并注册到 agentRunners。
//
// 直接从 init-runtime.ts import 被测函数（避免 index.ts 的 app.whenReady 等重副作用）。
// 通过 vi.mock 拦截 spawn 依赖（resolveBotToken / resolveApiKey / buildSpawnOpts /
// createTaskDrivenRuntime），不 fork 真子进程。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import type { AgentRunner } from '../../src/main/agent/agent-runner';

// ─── Mock 重依赖 ───────────────────────────────────────────────────────────
// 拦截 keychain / 网络 / fork 子进程调用，使测试可纯逻辑验证过滤行为。

vi.mock('../../src/main/agent/spawn-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/spawn-helpers')>();
  return {
    ...actual,
    resolveApiKey: vi.fn().mockResolvedValue('fake-llm-key'),
    // 返回最小 opts（仅 instanceId/agentUserId/workspaceId），不触发真 provider 查询
    buildSpawnOpts: vi.fn((input) => ({
      instanceId: input.instanceId,
      agentAssignmentId: input.instanceId,
      agentUserId: input.agentUserId,
      workspaceId: input.workspaceId,
      teamSessionId: input.teamSessionId,
    })),
  };
});

vi.mock('../../src/main/agent/runtime-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/runtime-registry')>();
  return {
    ...actual,
    // 模拟真实注册副作用：往 agentRunners 写入 stub runner，
    // 使测试可断言「过滤后哪些 assignment 被注册」。
    createTaskDrivenRuntime: vi.fn((opts) => {
      actual.agentRunners.set(opts.instanceId, {
        destroy() {},
      } as unknown as AgentRunner);
      return { warm: vi.fn().mockResolvedValue(undefined) };
    }),
    populateProviderBuckets: vi.fn(),
  };
});

// ─── 测试 fixture ───────────────────────────────────────────────────────────

const tmpRoot = path.join(os.tmpdir(), `task5-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
  vi.clearAllMocks();
});

/** 清空全局 runtime 注册表 + RouterService 单例（避免跨用例污染） */
async function clearRegistry(): Promise<void> {
  const reg = await import('../../src/main/agent/runtime-registry');
  const router = await import('../../src/main/agent/router-bootstrap');
  reg.__clearRuntimeRegistryForTest();
  router.__resetRouterServiceForTest();
}

// ─── 测试用例 ───────────────────────────────────────────────────────────────

describe('Task 5: initTaskDrivenRuntime lastRunning 过滤', () => {
  it('仅注册 last_running=1 的 task-driven agent，跳过 last_running=0', async () => {
    await clearRegistry();
    const db = getDb();

    // 1. workspace
    db.prepare(
      'INSERT INTO workspaces (id, name, owner_id, directory_path) VALUES (?, ?, ?, ?)',
    ).run('ws-task5', 'test-ws', '@owner:localhost', '/tmp');

    // 2. model provider（def.model_provider_id 不可为 NULL，否则被 guard 跳过）
    db.prepare(
      `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('prov-task5', 'Test Provider', 'http://localhost:11434', 'prov-key-ref', 'test-model', 0);

    // 3. 两个 task_driven=1 的 def（均配置 provider）
    for (const defId of ['def-online', 'def-offline']) {
      db.prepare(
        `INSERT INTO agent_definitions
          (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills,
           source, description, icon_emoji, model_provider_id, model_name, task_driven)
         VALUES (?, ?, ?, ?, 'declarative', '', '[]', '[]', '[]', 'builtin', '', '🤖', ?, '', 1)`,
      ).run(defId, defId, defId, '1.0.0', 'prov-task5');
    }

    // 4. 两个成员：last_running=1（在线） vs last_running=0（用户主动下线）
    db.prepare(
      `INSERT INTO workspace_agent_members
        (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
       VALUES (?, ?, ?, ?, 1)`,
    ).run('inst-online', 'ws-task5', 'def-online', '@bot-online:localhost');

    db.prepare(
      `INSERT INTO workspace_agent_members
        (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
       VALUES (?, ?, ?, ?, 0)`,
    ).run('inst-offline', 'ws-task5', 'def-offline', '@bot-offline:localhost');

    // 5. 调用被测函数
    const { initTaskDrivenRuntime } = await import('../../src/main/agent/init-runtime');
    await initTaskDrivenRuntime();

    // 6. 断言过滤结果
    const { agentRunners, createTaskDrivenRuntime } = await import('../../src/main/agent/runtime-registry');
    const mockCreate = vi.mocked(createTaskDrivenRuntime);

    // 6a. createTaskDrivenRuntime 仅被调用 1 次（inst-online）
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-online' }),
    );

    // 6b. agentRunners 仅含 inst-online（mock 注册副作用）
    expect(agentRunners.has('inst-online')).toBe(true);
    expect(agentRunners.has('inst-offline')).toBe(false);

    // 6c. Task R3：函数改返回 void；RouterService lazy 启动验证在
    // tests/agent/router-bootstrap.test.ts 单独覆盖（检查 ensureRouterService
    // 实际行为 + setRouterService 调用）。
  });

  it('last_running 全为 0 时不创建 RouterService，返回 null', async () => {
    await clearRegistry();
    const db = getDb();

    db.prepare(
      'INSERT INTO workspaces (id, name, owner_id, directory_path) VALUES (?, ?, ?, ?)',
    ).run('ws-task5b', 'test-ws', '@owner:localhost', '/tmp');

    db.prepare(
      `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('prov-task5b', 'Test Provider', 'http://localhost:11434', 'prov-key-ref', 'test-model', 0);

    db.prepare(
      `INSERT INTO agent_definitions
        (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills,
         source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES (?, ?, ?, ?, 'declarative', '', '[]', '[]', '[]', 'builtin', '', '🤖', ?, '', 1)`,
    ).run('def-only-off', 'def-only-off', 'def-only-off', '1.0.0', 'prov-task5b');

    // 唯一一个成员为 last_running=0
    db.prepare(
      `INSERT INTO workspace_agent_members
        (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
       VALUES (?, ?, ?, ?, 0)`,
    ).run('inst-only-off', 'ws-task5b', 'def-only-off', '@bot-only:localhost');

    const { initTaskDrivenRuntime } = await import('../../src/main/agent/init-runtime');
    await initTaskDrivenRuntime();

    // 无 runner 注册 → 跳过 RouterService / ensureRouterService（init-runtime 内部 early return）
  });

  it('enabled 列已退役：last_running=1 即注册（v25 单过滤语义）', async () => {
    await clearRegistry();
    const db = getDb();

    db.prepare(
      'INSERT INTO workspaces (id, name, owner_id, directory_path) VALUES (?, ?, ?, ?)',
    ).run('ws-task5c', 'test-ws', '@owner:localhost', '/tmp');

    db.prepare(
      `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('prov-task5c', 'Test Provider', 'http://localhost:11434', 'prov-key-ref', 'test-model', 0);

    db.prepare(
      `INSERT INTO agent_definitions
        (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills,
         source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES (?, ?, ?, ?, 'declarative', '', '[]', '[]', '[]', 'builtin', '', '🤖', ?, '', 1)`,
    ).run('def-disabled', 'def-disabled', 'def-disabled', '1.0.0', 'prov-task5c');

    // v25：enabled 列已随去编排退役——last_running 是「在线」唯一权威源
    db.prepare(
      `INSERT INTO workspace_agent_members
        (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
       VALUES (?, ?, ?, ?, 1)`,
    ).run('inst-disabled', 'ws-task5c', 'def-disabled', '@bot-disabled:localhost');

    const { initTaskDrivenRuntime } = await import('../../src/main/agent/init-runtime');
    await initTaskDrivenRuntime();

    const { agentRunners, createTaskDrivenRuntime } = await import('../../src/main/agent/runtime-registry');
    expect(vi.mocked(createTaskDrivenRuntime)).toHaveBeenCalledTimes(1);
    expect(agentRunners.has('inst-disabled')).toBe(true);
  });
});
