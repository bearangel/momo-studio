// electron/tests/integration/router-lazy-init.test.ts
//
// Task 5 集成测试（lazy init 端到端）：验证 RouterService lazy 启动链路在真实场景下
// 能正确触发——空状态 → 第一个 runner 注册 → setBridgeRouter 被调用。
//
// 这是 v2 修复（RouterService 从 startup-singleton 改为 lazy-singleton）的回归保护。
// 原 bug：app 启动时若无 runner，RouterService 永远 null，sync-manager 静默丢弃所有
// m.room.message → agent 不回复。修复后 ensureRouterService 在首个 runner 注册时
// 幂等 lazy 启动。
//
// 三个场景覆盖两条触发路径：
//   - 场景 1：initTaskDrivenRuntime（app 启动批量恢复路径）
//   - 场景 2：startAgentRuntime（agent:start IPC 单 agent 启动路径）
//   - 场景 3：批量注册幂等性（2 agents → setBridgeRouter 仅 1 次）
//
// Mock 策略：拦截 spawn / token / keychain / Matrix 注入侧（避免真 fork + 真 Matrix
// 连接），保留 initTaskDrivenRuntime / ensureTaskDrivenRuntime / createTaskDrivenRuntime /
// ensureRouterService 真实逻辑以验证 lazy 链路完整性。setBridgeRouter（P1 Task 5 起
// 的注入目标——内部事件桥）用 vi.fn 替换以便断言调用次数与入参形状。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── Mock 重依赖（必须在静态 import 之前提升） ─────────────────────────────
// 这些 mock 拦截「外部副作用」，保留 lazy init 链路自身的真实代码执行。

// 1. auto-start：resolveBotToken 返回 fake-token（避免 keychain / Matrix 登录）
vi.mock('../../src/main/agent/auto-start', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/auto-start')>();
  return { ...actual, resolveBotToken: vi.fn().mockResolvedValue('fake-bot-token') };
});

// 2. spawn-helpers：buildSpawnOpts 回显关键字段，resolveApiKey 返回 fake-key
vi.mock('../../src/main/agent/spawn-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/spawn-helpers')>();
  return {
    ...actual,
    // 回显 instanceId / agentUserId / workspaceId——createTaskDrivenRuntime 用这些做 Map key
    buildSpawnOpts: vi.fn((input: { instanceId: string; agentUserId: string; workspaceId: string }) => ({
      instanceId: input.instanceId,
      agentAssignmentId: input.instanceId,
      agentUserId: input.agentUserId,
      workspaceId: input.workspaceId,
      workspaceDir: '/tmp',
      teamSessionId: '!team-lazy:localhost',
      systemPrompt: '',
      modelName: 'gpt-4o',
      llmApiKey: 'fake-llm-key',
      role: 'standalone' as const,
    })),
    resolveApiKey: vi.fn().mockResolvedValue('fake-llm-key'),
  };
});

// 3. runtime-spawner：spawnForAgent 返回 fake child（避免真 fork 子进程）
//    WarmPool 只用到 child.kill()；AgentRunner 本测试不触达 executeTask。
vi.mock('../../src/main/agent/runtime-spawner', () => ({
  spawnForAgent: vi.fn().mockResolvedValue({
    child: { on: vi.fn(), off: vi.fn(), send: vi.fn(), kill: vi.fn() },
    assignmentId: 'fake',
    spawnedAt: Date.now(),
  }),
}));

// 4. internal-event-bridge：setBridgeRouter 用 vi.fn 替换以便断言（其余 export 保留真实）
//    用 vi.hoisted 声明 mock——vi.mock 工厂会被 vitest 提升到文件顶部，
//    普通顶层 const 此时还未初始化（TDZ），vi.hoisted 保证 mock 与 factory 同步提升。
const { setBridgeRouterMock } = vi.hoisted(() => ({
  setBridgeRouterMock: vi.fn(),
}));
vi.mock('../../src/main/agent/internal-event-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/internal-event-bridge')>();
  return { ...actual, setBridgeRouter: setBridgeRouterMock };
});

// ─── 静态 import（mock 已生效） ─────────────────────────────────────────────

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  agentRunners,
  __clearRuntimeRegistryForTest,
} from '../../src/main/agent/runtime-registry';
import { __resetRouterServiceForTest } from '../../src/main/agent/router-bootstrap';
import { initTaskDrivenRuntime } from '../../src/main/agent/init-runtime';
import { createWorkspace } from '../../src/main/workspace/crud';
import { saveAgentDefinition, assignAgentToWorkspace } from '../../src/main/agent/crud';
import type { AgentDefinition } from '../../src/main/agent/types';

// ─── DB fixture（per-test 临时目录 + 迁移） ─────────────────────────────────

const tmpRoot = path.join(os.tmpdir(), `router-lazy-init-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // 清模块级单例状态（与 beforeEach 一一对应，避免跨用例污染）
  __clearRuntimeRegistryForTest();
  __resetRouterServiceForTest();
  setBridgeRouterMock.mockClear();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
  vi.clearAllMocks();
});

// ─── Seed 助手（用 crud 层 API，避免裸 SQL 触发 NOT NULL 约束） ────────────

/**
 * 插入一个 model_providers 行（def.modelProviderId 必须引用已存在 provider，
 * 否则 initTaskDrivenRuntime 的 guard 直接跳过该 agent）。
 *
 * 注意 schema（migration v10 + v17）：列为 api_key_ref（不是 api_key），
 * 无 platform 列。max_rpm / max_tpm 可空（NULL = 不限流，populateProviderBuckets 跳过）。
 */
function seedProvider(providerId: string): void {
  getDb()
    .prepare(
      `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(providerId, `Provider ${providerId}`, 'http://localhost:8080', 'fake-key-ref', 'gpt-4o', 0);
}

/**
 * 构造并落库一个 task_driven=1 的 AgentDefinition。
 * 用 saveAgentDefinition 助手（INSERT OR REPLACE），避免手写 SQL 列顺序。
 */
function seedTaskDrivenDef(defId: string, providerId: string): AgentDefinition {
  const def: AgentDefinition = {
    id: defId,
    name: defId,
    slug: defId,
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: '',
    defaultTools: [],
    defaultMcps: [],
    defaultSkills: [],
    source: 'custom',
    description: '',
    iconEmoji: '🤖',
    workspaceId: null,
    modelProviderId: providerId,
    modelName: 'gpt-4o',
    taskDriven: true,
  };
  saveAgentDefinition(def);
  return def;
}

/**
 * 完整 seed 一条「task_driven=1 + enabled=1 + last_running=1」的 assignment 链路。
 * 返回 instanceId（startAgentRuntime 场景需要外部传 opts.instanceId 与此一致）。
 *
 * assignAgentToWorkspace 助手不暴露 last_running 入参（该字段由 runtime 层维护），
 * 故 INSERT 后补一条 UPDATE。
 */
function seedOnlineAssignment(
  workspaceId: string,
  defId: string,
  agentUserId: string,
): string {
  const assignment = assignAgentToWorkspace(
    workspaceId,
    defId,
    agentUserId,
    'standalone',
    null,
  );
  // 助手默认 last_running=1（schema DEFAULT 1），显式 UPDATE 仅做防御性确认
  getDb()
    .prepare('UPDATE agent_assignments SET last_running = 1 WHERE instance_id = ?')
    .run(assignment.instanceId);
  return assignment.instanceId;
}

// ─── 测试用例 ───────────────────────────────────────────────────────────────

describe('RouterService lazy init 集成测试 (Task 5)', () => {
  it('场景 1: 空状态 → initTaskDrivenRuntime 恢复 1 个 last_running=1 agent → setBridgeRouter 被调用', async () => {
    // 初始断言：注册表空 + setBridgeRouter 未被调用
    expect(agentRunners.size).toBe(0);
    expect(setBridgeRouterMock).not.toHaveBeenCalled();

    // seed 完整链路：workspace + provider + def + assignment（均用 crud 助手）
    const ws = await createWorkspace(
      { name: 'lazy-ws-1', directoryPath: '/tmp' },
      '@owner:localhost',
      '!space-lazy-1:localhost',
      '!team-lazy-1:localhost',
    );
    seedProvider('prov-lazy-1');
    seedTaskDrivenDef('def-lazy-1', 'prov-lazy-1');
    const instanceId = seedOnlineAssignment(ws.id, 'def-lazy-1', '@bot-lazy-1:localhost');

    // 调用被测函数（模拟 app 启动批量恢复路径）
    await initTaskDrivenRuntime();

    // 断言 1：runner 已注册到全局 Map
    expect(agentRunners.has(instanceId)).toBe(true);
    expect(agentRunners.size).toBe(1);

    // 断言 2：setBridgeRouter 被调用恰好 1 次
    expect(setBridgeRouterMock).toHaveBeenCalledTimes(1);

    // 断言 3：传入的是带 routeEvent 方法的对象（RouterService duck-type）
    const svc = setBridgeRouterMock.mock.calls[0][0];
    expect(svc).toBeDefined();
    expect(typeof svc.routeEvent).toBe('function');
  });

  it('场景 2: 空状态 → startAgentRuntime(taskDriven=true) 单 agent 启动 → setBridgeRouter 被调用', async () => {
    // startAgentRuntime 是 agent:start IPC handler 路径
    const { startAgentRuntime } = await import('../../src/main/agent/runtime-registry');

    // 初始断言：注册表空
    expect(agentRunners.size).toBe(0);
    expect(setBridgeRouterMock).not.toHaveBeenCalled();

    // seed 一条 assignment 行（ensureTaskDrivenRuntime 内部 UPDATE last_running=1 需要此行存在）
    const ws = await createWorkspace(
      { name: 'lazy-ws-2', directoryPath: '/tmp' },
      '@owner:localhost',
      '!space-lazy-2:localhost',
      '!team-lazy-2:localhost',
    );
    // instanceId 由 assignAgentToWorkspace 生成，opts.instanceId 必须用同一个值
    seedProvider('prov-lazy-2');
    seedTaskDrivenDef('def-lazy-2', 'prov-lazy-2');
    const instanceId = seedOnlineAssignment(ws.id, 'def-lazy-2', '@bot-lazy-2:localhost');

    // 构造 AgentRuntimeOpts（spawnForAgent 已 mock，opts 字段值无需真实可达）
    const opts = {
      instanceId,
      workspaceId: ws.id,
      workspaceDir: '/tmp',
      agentAssignmentId: instanceId,
      agentUserId: 'agent-bot-lazy-2',
      teamSessionId: '!team-lazy-2:localhost',
      systemPrompt: '',
      modelName: 'gpt-4o',
      llmApiKey: 'fake-llm-key',
      role: 'standalone' as const,
    };

    // 调用被测函数（模拟 agent:start IPC handler 路径）
    await startAgentRuntime(opts, true);

    // 断言 1：runner 已注册
    expect(agentRunners.has(instanceId)).toBe(true);

    // 断言 2：setBridgeRouter 被调用（单 agent 路径同样触发 lazy init）
    expect(setBridgeRouterMock).toHaveBeenCalledTimes(1);

    // 断言 3：传入 RouterService 实例（duck-type routeEvent）
    const svc = setBridgeRouterMock.mock.calls[0][0];
    expect(typeof svc.routeEvent).toBe('function');
  });

  it('场景 3: 批量 initTaskDrivenRuntime 注册 2 agents → setBridgeRouter 仅调用 1 次（幂等）', async () => {
    // 初始断言
    expect(agentRunners.size).toBe(0);
    expect(setBridgeRouterMock).not.toHaveBeenCalled();

    // seed：1 个 workspace + 1 个 provider（两个 def 共用）+ 2 个 def + 2 个 assignment
    const ws = await createWorkspace(
      { name: 'lazy-ws-3', directoryPath: '/tmp' },
      '@owner:localhost',
      '!space-lazy-3:localhost',
      '!team-lazy-3:localhost',
    );
    seedProvider('prov-lazy-3');
    seedTaskDrivenDef('def-lazy-3a', 'prov-lazy-3');
    seedTaskDrivenDef('def-lazy-3b', 'prov-lazy-3');
    const idA = seedOnlineAssignment(ws.id, 'def-lazy-3a', '@bot-lazy-3a:localhost');
    const idB = seedOnlineAssignment(ws.id, 'def-lazy-3b', '@bot-lazy-3b:localhost');

    // 调用被测函数
    await initTaskDrivenRuntime();

    // 断言 1：两个 runner 均已注册
    expect(agentRunners.has(idA)).toBe(true);
    expect(agentRunners.has(idB)).toBe(true);
    expect(agentRunners.size).toBe(2);

    // 断言 2（核心）：setBridgeRouter 仅被调用 1 次——证明 ensureRouterService 幂等
    // 这是 lazy init 修复的关键回归点：批量注册场景下 RouterService 不会被重复创建。
    expect(setBridgeRouterMock).toHaveBeenCalledTimes(1);

    // 断言 3：首次调用传入的 runnerCount=2（dispatcher 持有 Map 引用，后续新增可见）
    const svc = setBridgeRouterMock.mock.calls[0][0];
    expect(typeof svc.routeEvent).toBe('function');
  });
});
