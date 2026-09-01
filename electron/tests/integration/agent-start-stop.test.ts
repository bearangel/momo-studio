// electron/tests/integration/agent-start-stop.test.ts
//
// Spec § 5.2 集成测试 #8（final review I2 补齐）。
//
// 覆盖 task-driven agent 的完整 start → stop → start 生命周期 + DB last_running 同步：
//   1. agent:start → runner 注册 + DB last_running=1
//   2. agent:stop  → runner 销毁 + DB last_running=0
//   3. start → stop → start 循环 → 最终 DB last_running=1（C1 regression）
//
// 设计要点（与 ipc-stop-start.test.ts 的关键差异）：
//   - 本测试保持 runtime-registry 为 REAL（不 mock startAgentRuntime），
//     使 ensureTaskDrivenRuntime 真正执行——验证 C1 修复（写 last_running=1）。
//   - ipc-stop-start.test.ts 把 startAgentRuntime mock 成 vi.fn，无法发现 C1。
//   - runtime-spawner 被 mock（不 fork 真子进程），但 WarmPool / AgentRunner 为真实对象。
//
// 通过 mock electron.ipcMain.handle 捕获真实注册的 handler，
// 测试直接调用捕获的回调——验证生产 handler 而非逻辑副本。

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';

// vi.hoisted 保证 ipcHandlers 在 vi.mock 工厂提升前就绪
const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

// mock electron：捕获 ipcMain.handle 注册的 handler 供测试直接调用
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

// mock logger（避免 side effects）
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// mock runtime-status（避免真实 DB 读）
vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));

// mock runtime-spawner（避免真实 fork 子进程）；WarmPool / AgentRunner 保持真实
vi.mock('../../src/main/agent/runtime-spawner', () => ({
  spawnForAgent: vi.fn().mockResolvedValue({
    child: {
      kill: vi.fn(),
      pid: 12345,
      on: vi.fn(),
      off: vi.fn(),
      send: vi.fn(),
      connected: true,
    } as unknown as ChildProcess,
    destroy: vi.fn(),
    assignmentId: '',
    spawnedAt: Date.now(),
  }),
}));

// mock spawn-helpers：buildSpawnOpts 透传真实 instanceId/agentUserId/workspaceId；
// resolveApiKey 返回 fake（避免 keychain provider key 查询）
vi.mock('../../src/main/agent/spawn-helpers', () => ({
  buildSpawnOpts: vi.fn((input: {
    instanceId: string;
    agentUserId: string;
    workspaceId: string;
  }) => ({
    instanceId: input.instanceId,
    agentAssignmentId: input.instanceId,
    agentUserId: input.agentUserId,
    workspaceId: input.workspaceId,
    workspaceDir: '/tmp',
    teamSessionId: '!room:home',
    agentDefinitionId: 'def-test',
    slug: 'test-agent',
    systemPrompt: '',
    llmApiKey: 'k',
    role: 'standalone',
    subAgents: [],
    mcpServers: [],
    skills: [],
    allowedTools: [],
    maxToolCalls: 10,
    isLeader: false,
    taskDriven: true,
  })),
  resolveApiKey: vi.fn(async () => 'fake-llm-key'),
}));

// mock 其余 ipc.handlers.ts 顶层依赖（仅注册时 import 触发，运行时无调用）
vi.mock('../../src/main/agent/manifest-parser', () => ({
  parseAgentManifest: vi.fn(),
}));
vi.mock('../../src/main/agent/builtin', () => ({
  getBuiltinSuggestionsMap: vi.fn(() => ({})),
}));
vi.mock('../../src/main/agent/assignment-capabilities', () => ({
  getAssignmentDeltas: vi.fn(() => ({})),
  setAssignmentDeltas: vi.fn(),
}));

// 注意：runtime-registry / crud / workspace/crud / keychain 保持 REAL
// —— 这是本测试能验证 C1（ensureTaskDrivenRuntime 写 DB）的关键。

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  agentRunners,
  agentWarmPools,
  __clearRuntimeRegistryForTest,
} from '../../src/main/agent/runtime-registry';
import { createWorkspace } from '../../src/main/workspace/crud';
import {
  saveAgentDefinition,
  assignAgentToWorkspace,
} from '../../src/main/agent/crud';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import type { AgentDefinition, AgentAssignment } from '../../src/main/agent/types';

// 注册一次即可；后续测试用例从 ipcHandlers Map 取回调
let registerAgentHandlers: () => void;

const tmpRoot = path.join(os.tmpdir(), `ap-start-stop-${Date.now()}-${process.pid}`);
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};

beforeAll(async () => {
  // 动态 import：vi.mock 提升在静态 import 之前生效
  const mod = await import('../../src/main/agent/ipc.handlers');
  registerAgentHandlers = mod.registerAgentHandlers;
});

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
  // model_providers 表预建（crud 读取 def.modelProviderId 时需存在）
  getDb().prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default)
     VALUES ('prov-1', 'Test Provider', 'https://api.openai.com', 'provider.prov-1.api_key', 'gpt-4o', 1)`,
  ).run();
  ipcHandlers.clear();
  __clearRuntimeRegistryForTest();
  registerAgentHandlers();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

/** 构造一个 task-driven standalone agent 定义并落库 */
function makeTaskDrivenDef(id: string): AgentDefinition {
  const def: AgentDefinition = {
    id,
    name: 'StartStop',
    slug: `start-stop-${id}`,
    version: '1.0',
    runtime: 'declarative',
    systemPrompt: 'p',
    defaultTools: [],
    source: 'custom',
    description: 'd',
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: 'prov-1',
    modelName: 'gpt-4o',
    taskDriven: true,
  };
  saveAgentDefinition(def);
  return def;
}

/** 查询 assignment 的 last_running 值 */
function getLastRunning(instanceId: string): number {
  const row = getDb()
    .prepare('SELECT last_running FROM agent_assignments WHERE instance_id = ?')
    .get(instanceId) as { last_running: number } | undefined;
  return row?.last_running ?? -1;
}

/** seed 一个 workspace + def + assignment（last_running 预置为指定值） */
async function seedFixture(
  defId: string,
  lastRunning: 0 | 1,
): Promise<{ assignment: AgentAssignment; workspaceId: string }> {
  const def = makeTaskDrivenDef(defId);
  const ws = await createWorkspace(
    {
      name: 'WS',
      description: '',
      directoryPath: path.join(tmpRoot, `ws-${defId}`),
      iconEmoji: '📁',
    },
    '@o:localhost', '!s:localhost', '!t:localhost',
  );
  const assignment = assignAgentToWorkspace(
    ws.id, def.id, `@bot-${defId}:localhost`, 'standalone',
  );
  // assignment 默认 last_running=1（migration default）；测试需精确控制初值
  getDb()
    .prepare('UPDATE agent_assignments SET last_running = ? WHERE instance_id = ?')
    .run(lastRunning, assignment.instanceId);
  // keychain 预置 bot token（agent:start handler 会读）
  memStore.set(`bot.@bot-${defId}:localhost.matrix_token`, 'fake-bot-token');
  return { assignment, workspaceId: ws.id };
}

describe('agent:start + agent:stop 生命周期（Spec § 5.2 #8 / final review I2）', () => {
  it('task-driven agent: start → DB last_running=1 + runner/pool 注册', async () => {
    // 初值 last_running=0（模拟从未启动或已停止状态）
    const { assignment, workspaceId } = await seedFixture('def-start-1', 0);
    const instId = assignment.instanceId;
    expect(getLastRunning(instId)).toBe(0);

    const handler = ipcHandlers.get('agent:start');
    expect(handler).toBeDefined();
    const res = await handler!(null, { assignment, workspaceId });
    expect(res).toEqual({ instanceId: instId });

    // C1 关键断言：start 后 DB last_running 必须为 1
    expect(getLastRunning(instId)).toBe(1);
    // runner + pool 已注册
    expect(agentRunners.has(instId)).toBe(true);
    expect(agentWarmPools.has(instId)).toBe(true);
  });

  it('task-driven agent: stop → DB last_running=0 + runner/pool 销毁', async () => {
    // 先 seed 一个 last_running=1 + runner 已注册的状态（模拟运行中）
    const { assignment, workspaceId } = await seedFixture('def-stop-1', 1);
    const instId = assignment.instanceId;

    // 先 start 让 runner 真实注册（确保 stop 有东西可销毁）
    const startHandler = ipcHandlers.get('agent:start');
    await startHandler!(null, { assignment, workspaceId });
    expect(agentRunners.has(instId)).toBe(true);

    const stopHandler = ipcHandlers.get('agent:stop');
    expect(stopHandler).toBeDefined();
    const res = await stopHandler!(null, instId);
    expect(res).toEqual({ ok: true });

    // 断言：DB last_running=0 + runner/pool 已销毁
    expect(getLastRunning(instId)).toBe(0);
    expect(agentRunners.has(instId)).toBe(false);
    expect(agentWarmPools.has(instId)).toBe(false);
  });

  it('task-driven agent: start → stop → start 循环 DB 状态正确（C1 regression）', async () => {
    // C1 核心场景：stop 写 0 后，第二次 start 必须把 DB 写回 1
    const { assignment, workspaceId } = await seedFixture('def-cycle-1', 0);
    const instId = assignment.instanceId;

    const startHandler = ipcHandlers.get('agent:start');
    const stopHandler = ipcHandlers.get('agent:stop');

    // 第一次 start
    await startHandler!(null, { assignment, workspaceId });
    expect(getLastRunning(instId)).toBe(1);
    expect(agentRunners.has(instId)).toBe(true);

    // stop
    await stopHandler!(null, instId);
    expect(getLastRunning(instId)).toBe(0);
    expect(agentRunners.has(instId)).toBe(false);

    // 第二次 start（C1 关键：必须重新写 last_running=1 + 重建 runner）
    await startHandler!(null, { assignment, workspaceId });
    expect(getLastRunning(instId)).toBe(1);
    expect(agentRunners.has(instId)).toBe(true);
    expect(agentWarmPools.has(instId)).toBe(true);
  });
});
