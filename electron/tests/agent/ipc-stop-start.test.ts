// electron/tests/agent/ipc-stop-start.test.ts
//
// Task 4 回归测试——验证 agent:stop IPC handler 走 v2 双轨销毁。
//
// 旧实现只调 v1 stopAgent（runtime-manager），对 task-driven runner 无效。
// 新实现应调 stopAgentRuntime（runtime-registry），同时销毁 v2 WarmPool/AgentRunner
// + 幂等写 DB last_running=0。
//
// 通过 mock electron.ipcMain.handle 捕获真实注册的 handler，
// 测试直接调用捕获的回调 —— 验证的是生产 handler（而非逻辑副本），
// 与 provider-ipc-handlers.test.ts 同一约定。

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

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

// mock runtime-manager（v1 stopAgent 走 vi.fn；避免真实 kill 子进程）
vi.mock('../../src/main/agent/runtime-manager', () => ({
  stopAgent: vi.fn(),
  isAgentRunning: vi.fn(() => false),
  spawnAgent: vi.fn(),
  handleStreamChunk: vi.fn(),
}));

// mock 其余 ipc.handlers.ts 顶层依赖（仅注册时 import 触发，无运行时调用）
vi.mock('../../src/main/agent/manifest-parser', () => ({
  parseAgentManifest: vi.fn(),
}));
vi.mock('../../src/main/agent/crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/crud')>();
  return {
    ...actual,
    listAgentDefinitions: vi.fn(() => []),
    getAgentDefinition: vi.fn(() => null),
    listAssignments: vi.fn(() => []),
    updateAssignmentRole: vi.fn(),
    updateAssignmentApiKey: vi.fn(),
    listSubAssignments: vi.fn(() => []),
    deleteDefinition: vi.fn(),
    updateAgentDefinition: vi.fn(),
    createCustomDef: vi.fn(),
    stopRunningInstancesByDefinition: vi.fn(() => []),
  };
});
vi.mock('../../src/main/workspace/crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/workspace/crud')>();
  return {
    ...actual,
    getWorkspace: vi.fn(() => null),
    setWorkspaceCoordinator: vi.fn(),
  };
});
vi.mock('../../src/main/storage/keychain', () => ({
  getSecret: vi.fn(async () => null),
  deleteSecret: vi.fn(async () => undefined),
  setSecret: vi.fn(),
  setKeychainImpl: vi.fn(),
}));
vi.mock('../../src/main/agent/bot-registrar', () => ({
  registerAgentBot: vi.fn(),
}));
vi.mock('../../src/main/matrix/rooms', () => ({
  inviteBotToRoom: vi.fn(async () => undefined),
}));
vi.mock('../../src/main/matrix/session', () => ({
  getOwnerMatrixClient: vi.fn(async () => ({})),
  getCurrentUserId: vi.fn(() => '@o:localhost'),
}));
vi.mock('../../src/main/matrix/sync-manager', () => ({
  getSyncingClient: vi.fn(() => null),
}));
vi.mock('../../src/main/matrix/client', () => ({
  createMatrixClient: vi.fn(),
}));
vi.mock('../../src/main/agent/spawn-helpers', () => ({
  buildSpawnOpts: vi.fn(() => ({})),
  HOMESERVER_URL: 'http://127.0.0.1:8008',
  resolveApiKey: vi.fn(async () => 'k'),
}));
vi.mock('../../src/main/agent/builtin', () => ({
  getBuiltinSuggestionsMap: vi.fn(() => ({})),
}));
vi.mock('../../src/main/agent/assignment-capabilities', () => ({
  getAssignmentDeltas: vi.fn(() => ({})),
  setAssignmentDeltas: vi.fn(),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { stopAgent } from '../../src/main/agent/runtime-manager';
import {
  agentRunners,
  agentWarmPools,
  __clearRuntimeRegistryForTest,
} from '../../src/main/agent/runtime-registry';
import { createWorkspace } from '../../src/main/workspace/crud';
import { saveAgentDefinition, assignAgentToWorkspace } from '../../src/main/agent/crud';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import type { AgentRunner } from '../../src/main/agent/agent-runner';
import type { WarmPool } from '../../src/main/agent/warm-pool';
import type { AgentDefinition } from '../../src/main/agent/types';

// 注册一次即可；后续测试用例从 ipcHandlers Map 取回调
let registerAgentHandlers: () => void;

const tmpRoot = path.join(os.tmpdir(), `ap-ipc-stop-start-${Date.now()}-${process.pid}`);
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
  // v1.3：model_providers 表需预建（避免被 import 副作用触发外键）
  getDb().prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default)
     VALUES ('prov-1', 'Test Provider', 'https://api.openai.com', 'provider.prov-1.api_key', 'gpt-4o', 1)`,
  ).run();
  ipcHandlers.clear();
  vi.mocked(stopAgent).mockClear();
  __clearRuntimeRegistryForTest();
  registerAgentHandlers();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

/** 构造一个最小可用的 standalone agent 定义并落库 */
function makeStandaloneDef(id: string): AgentDefinition {
  const def: AgentDefinition = {
    id,
    name: 'StopStart',
    slug: `stop-start-${id}`,
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

describe('agent:stop IPC handler（Task 4 双轨销毁）', () => {
  it('停止 task-driven agent：销毁 runner + 写 last_running=0', async () => {
    // 准备 DB：用 helpers 落库（避免 NOT NULL 约束失败）
    const def = makeStandaloneDef('def-stop-1');
    const ws = await createWorkspace(
      { name: 'WS', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
      '@o:localhost', '!s:localhost', '!t:localhost',
    );
    const assignment = assignAgentToWorkspace(ws.id, def.id, '@bot-stop:localhost', 'standalone');
    const instId = assignment.instanceId;

    // 准备 fake runner + pool（模拟 task-driven runtime 已运行）
    const fakeRunner = {
      destroy: vi.fn(),
      assignmentId: instId,
      botUserId: '@bot-stop:localhost',
      workspaceId: ws.id,
      executeTask: vi.fn(),
      abortStream: vi.fn(),
      activeTaskCount: vi.fn(() => 0),
      notifyTaskReply: vi.fn(),
    } as unknown as AgentRunner;
    const fakePool = {
      destroyAll: vi.fn(),
      warm: vi.fn(),
      acquire: vi.fn(),
      release: vi.fn(),
      size: vi.fn(() => 0),
    } as unknown as WarmPool;
    agentRunners.set(instId, fakeRunner);
    agentWarmPools.set(instId, fakePool);

    // 调用真实注册的 agent:stop handler
    const handler = ipcHandlers.get('agent:stop');
    expect(handler).toBeDefined();
    const res = await handler!(null, instId);
    expect(res).toEqual({ ok: true });

    // 验证：v2 runner/pool 已被销毁并从 Map 移除
    expect(agentRunners.has(instId)).toBe(false);
    expect(agentWarmPools.has(instId)).toBe(false);
    expect(fakeRunner.destroy).toHaveBeenCalledOnce();
    expect(fakePool.destroyAll).toHaveBeenCalledOnce();

    // 验证：v1 stopAgent 也被调（双轨语义）
    expect(stopAgent).toHaveBeenCalledWith(instId);

    // 验证：DB last_running 写为 0
    const row = getDb()
      .prepare('SELECT last_running FROM agent_assignments WHERE instance_id = ?')
      .get(instId) as { last_running: number };
    expect(row.last_running).toBe(0);
  });

  it('停止不存在的 instanceId 时双轨都不报错（幂等 no-op + DB 幂等写 0）', async () => {
    const handler = ipcHandlers.get('agent:stop');
    expect(handler).toBeDefined();
    const res = await handler!(null, 'inst-nonexistent');
    expect(res).toEqual({ ok: true });
    // v1 + v2 都接受不存在的 id（stopAgent 是 no-op，destroyTaskDrivenRuntime 是 no-op）
    expect(stopAgent).toHaveBeenCalledWith('inst-nonexistent');
    expect(agentRunners.has('inst-nonexistent')).toBe(false);
    expect(agentWarmPools.has('inst-nonexistent')).toBe(false);
  });
});
