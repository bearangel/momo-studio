// workspace:setCoordinator 自动重启单测
//
// 验证：设定协调 agent 后，若该实例正在运行，主进程自动停止并以 isCoordinator=true
// 重启——取代旧版"提示用户手动停止+启动"的交互。
//
// 捕获方式：mock electron.ipcMain.handle，把 workspace:setCoordinator 回调存入 Map，
// 测试直接调用捕获的回调 —— 验证的是真实生产 handler（而非逻辑副本），与
// agent/ipc-validation.test.ts 同一约定。
//
// runtime-manager 被 mock（避免 fork 真实子进程）；allocation 被 mock 返回空分配；
// 其余（storage/db + keychain + workspace/crud + agent/crud + capability-merger）走真实实现。

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { saveAgentDefinition, assignAgentToWorkspace } from '../../src/main/agent/crud';
import { createWorkspace } from '../../src/main/workspace/crud';
import type { AgentDefinition } from '../../src/main/agent/types';

// 捕获 ipcMain.handle 注册的回调（vi.hoisted 保证在 vi.mock 工厂提升前就绪）
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
// runtime-manager mock 引用同样需要 hoisted
const { stopAgentMock, spawnAgentMock, isAgentRunningMock } = vi.hoisted(() => ({
  stopAgentMock: vi.fn(),
  spawnAgentMock: vi.fn(),
  isAgentRunningMock: vi.fn(() => false),
}));

// mock runtime-manager：避免 fork 真实子进程；通过 isAgentRunningMock 控制运行状态
vi.mock('../../src/main/agent/runtime-manager', () => ({
  stopAgent: stopAgentMock,
  spawnAgent: spawnAgentMock,
  isAgentRunning: isAgentRunningMock,
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  startAgentRuntime: (opts: unknown) => spawnAgentMock(opts),
}));

// mock allocation：避免依赖 workspace_allocations 表，返回空分配即可
vi.mock('../../src/main/workspace/allocation', () => ({
  getAllocation: vi.fn(() => ({ workspaceId: '', tools: [], skills: [], mcps: [] })),
}));

// mock electron：捕获 ipcMain.handle 注册的 handler 供测试直接调用
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

let registerWorkspaceHandlers: () => void;

const tmpRoot = path.join(os.tmpdir(), `ap-coord-restart-${Date.now()}-${process.pid}`);
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) {
    memStore.set(k, v);
  },
  async getSecret(k) {
    return memStore.get(k) ?? null;
  },
  async deleteSecret(k) {
    memStore.delete(k);
  },
};

beforeAll(async () => {
  // 一次性导入模块并取出 registerWorkspaceHandlers，注册后 channel→handler 落入 Map
  const mod = await import('../../src/main/workspace/ipc.handlers');
  registerWorkspaceHandlers = mod.registerWorkspaceHandlers;
});

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
  // v1.3：buildSpawnOpts 读 model_providers 表，需预建 provider 记录
  getDb().prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default)
     VALUES ('prov-1', 'Test Provider', 'https://api.openai.com', 'provider.prov-1.api_key', 'gpt-4o', 1)`,
  ).run();
  handlers.clear();
  registerWorkspaceHandlers();
  stopAgentMock.mockClear();
  spawnAgentMock.mockClear();
  isAgentRunningMock.mockImplementation(() => false);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

/** 构造一个最小可用的 standalone agent 定义并落库 */
function makeStandaloneDef(): AgentDefinition {
  const def: AgentDefinition = {
    id: 'def-1',
    name: 'A',
    slug: 'a',
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
  };
  saveAgentDefinition(def);
  return def;
}

/**
 * 构造 main + 2 个 sub 定义并落库，返回 main def。
 * 用于测试协调重启路径下 main agent 的 subAgents 重建（C1）。
 * v1.3：def 不含 type/parent；subs 通过 assignment.parent_instance_id 关联。
 */
function makeMainWithSubs(): AgentDefinition {
  const main: AgentDefinition = {
    id: 'main-coord', name: 'PM', slug: 'pm-coord', version: '1.0',
    runtime: 'declarative', systemPrompt: '你是 PM',
    defaultTools: [], source: 'custom', description: 'PM', iconEmoji: '📋',
    defaultMcps: [], defaultSkills: [],
    workspaceId: null, modelProviderId: 'prov-1', modelName: 'gpt-4o',
  };
  const sub1: AgentDefinition = {
    id: 'sub-coord-1', name: 'Coder', slug: 'coder-coord', version: '1.0',
    runtime: 'declarative', systemPrompt: '写代码',
    defaultTools: [], source: 'custom', description: 'coder', iconEmoji: '🔗',
    defaultMcps: [], defaultSkills: [],
    workspaceId: null, modelProviderId: 'prov-1', modelName: 'gpt-4o',
  };
  const sub2: AgentDefinition = {
    id: 'sub-coord-2', name: 'QA', slug: 'qa-coord', version: '1.0',
    runtime: 'declarative', systemPrompt: '测试',
    defaultTools: [], source: 'custom', description: 'qa', iconEmoji: '🔗',
    defaultMcps: [], defaultSkills: [],
    workspaceId: null, modelProviderId: 'prov-1', modelName: 'gpt-4o',
  };
  saveAgentDefinition(main);
  saveAgentDefinition(sub1);
  saveAgentDefinition(sub2);
  return main;
}

describe('setCoordinator 自动重启', () => {
  it('实例运行中：设定协调后自动停止并以 isCoordinator=true 重启', async () => {
    const def = makeStandaloneDef();
    const ws = await createWorkspace(
      {
        name: 'w',
        description: '',
        directoryPath: path.join(tmpRoot, 'ws'),
        iconEmoji: '📁',
      },
      '@o:localhost',
      '!s:localhost',
      '!t:localhost',
    );
    const assignment = assignAgentToWorkspace(ws.id, def.id, '@bot:localhost', 'standalone');
    // 预填 keychain：runtime 重启需要 LLM apiKey 与 bot matrix token
    memStore.set('provider.prov-1.api_key', 'llm-key');
    memStore.set('bot.@bot:localhost.matrix_token', 'mx-token');

    // 模拟实例正在运行
    isAgentRunningMock.mockImplementation(() => true);

    const handler = handlers.get('workspace:setCoordinator')!;
    await handler({}, ws.id, assignment.instanceId);

    // 先停止旧实例
    expect(stopAgentMock).toHaveBeenCalledTimes(1);
    expect(stopAgentMock).toHaveBeenCalledWith(assignment.instanceId);
    // 再以 isCoordinator=true 重新启动
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    const opts = spawnAgentMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.instanceId).toBe(assignment.instanceId);
    expect(opts.isCoordinator).toBe(true);
    expect(opts.botUserId).toBe('@bot:localhost');
    expect(opts.workspaceId).toBe(ws.id);
  });

  it('实例未运行：只写 coordinatorInstanceId，不 stop/spawn', async () => {
    const def = makeStandaloneDef();
    const ws = await createWorkspace(
      {
        name: 'w2',
        description: '',
        directoryPath: path.join(tmpRoot, 'ws2'),
        iconEmoji: '📁',
      },
      '@o:localhost',
      '!s2:localhost',
      '!t2:localhost',
    );
    const assignment = assignAgentToWorkspace(ws.id, def.id, '@bot2:localhost', 'standalone');
    memStore.set('provider.prov-1.api_key', 'llm-key');
    memStore.set('bot.@bot2:localhost.matrix_token', 'mx-token');

    // 实例未运行（isAgentRunningMock 默认返回 false）
    const handler = handlers.get('workspace:setCoordinator')!;
    await handler({}, ws.id, assignment.instanceId);

    expect(stopAgentMock).not.toHaveBeenCalled();
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('清空协调（instanceId=null）：不触发重启', async () => {
    const def = makeStandaloneDef();
    const ws = await createWorkspace(
      {
        name: 'w3',
        description: '',
        directoryPath: path.join(tmpRoot, 'ws3'),
        iconEmoji: '📁',
      },
      '@o:localhost',
      '!s3:localhost',
      '!t3:localhost',
    );
    assignAgentToWorkspace(ws.id, def.id, '@bot3:localhost', 'standalone');
    isAgentRunningMock.mockImplementation(() => true);

    const handler = handlers.get('workspace:setCoordinator')!;
    // 传 null = 取消协调，不应重启
    await handler({}, ws.id, null);

    expect(stopAgentMock).not.toHaveBeenCalled();
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('main agent 协调重启 → spawnAgent 收到正确的 subAgents（C1）', async () => {
    const mainDef = makeMainWithSubs();
    const ws = await createWorkspace(
      {
        name: 'w-main-coord',
        description: '',
        directoryPath: path.join(tmpRoot, 'ws-main-coord'),
        iconEmoji: '📁',
      },
      '@o:localhost',
      '!s-mc:localhost',
      '!t-mc:localhost',
    );

    // v1.3：显式传 role + parentInstanceId 建立主子关系
    const mainAssignment = assignAgentToWorkspace(ws.id, mainDef.id, '@pm-coord:localhost', 'main');
    assignAgentToWorkspace(ws.id, 'sub-coord-1', '@coder-coord:localhost', 'sub', mainAssignment.instanceId);
    assignAgentToWorkspace(ws.id, 'sub-coord-2', '@qa-coord:localhost', 'sub', mainAssignment.instanceId);

    // v1.3：apiKey 走 provider key（resolveApiKey 读 provider.prov-1.api_key）
    memStore.set('provider.prov-1.api_key', 'llm-key');
    memStore.set('bot.@pm-coord:localhost.matrix_token', 'mx-token');

    isAgentRunningMock.mockImplementation(() => true);

    const handler = handlers.get('workspace:setCoordinator')!;
    await handler({}, ws.id, mainAssignment.instanceId);

    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    const opts = spawnAgentMock.mock.calls[0]![0] as {
      role?: string;
      isCoordinator?: boolean;
      subAgents?: Array<{ slug: string; botUserId: string }>;
    };
    expect(opts.role).toBe('main');
    expect(opts.isCoordinator).toBe(true);
    // ★ C1 核心断言：协调重启后 main 仍携带全部 subAgents
    expect(opts.subAgents).toBeDefined();
    expect(opts.subAgents).toHaveLength(2);
    expect(opts.subAgents!.map((s) => s.slug).sort()).toEqual(['coder-coord', 'qa-coord']);
  });
});
