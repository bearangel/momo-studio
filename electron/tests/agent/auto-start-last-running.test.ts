// electron/tests/agent/auto-start-last-running.test.ts
//
// v1.5.8 autoStartAgents 查询测试：验证 enabled=1 AND last_running=1 的过滤逻辑。
// runtime-manager 被 mock（避免 fork）；其余走真实 DB + keychain + crud。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { saveAgentDefinition } from '../../src/main/agent/crud';
import { createWorkspace } from '../../src/main/workspace/crud';
import type { AgentDefinition } from '../../src/main/agent/types';

// mock runtime-manager：捕获 spawnAgent / isV1SubprocessAlive 调用，避免 fork 真实子进程
const { spawnAgentMock, isV1SubprocessAliveMock } = vi.hoisted(() => ({
  spawnAgentMock: vi.fn(),
  isV1SubprocessAliveMock: vi.fn(() => false),
}));

vi.mock('../../src/main/agent/runtime-manager', () => ({
  spawnAgent: spawnAgentMock,
  isV1SubprocessAlive: isV1SubprocessAliveMock,
}));

// v1.5.8：mock matrix client，支持按 botUserId 路由 whoami 返回值
const whoamiImpl = vi.hoisted(() => vi.fn().mockResolvedValue({ user_id: '@bot:localhost' }));
// v1.5.8：mock matrix client 的 login（token 失效后 re-login 路径用）
const loginImpl = vi.hoisted(() => vi.fn().mockResolvedValue({ access_token: 'fresh-token' }));
vi.mock('../../src/main/matrix/client', () => ({
  createMatrixClient: (opts: { userId?: string; accessToken?: string }) => ({
    whoami: () => whoamiImpl(opts.userId),
    login: (type: string, params: { user: string; password: string }) =>
      loginImpl(type, params),
  }),
}));

// 在 mock 之后导入被测模块
import { autoStartAgents } from '../../src/main/agent/auto-start';

const tmpRoot = path.join(os.tmpdir(), `ap-auto-start-${Date.now()}-${process.pid}`);
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
  // buildSpawnOpts 读 model_providers 表
  getDb().prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default)
     VALUES ('prov-1', 'Test', 'https://api.openai.com', 'provider.prov-1.api_key', 'gpt-4o', 1)`,
  ).run();
  spawnAgentMock.mockClear();
  isV1SubprocessAliveMock.mockImplementation(() => false);
  whoamiImpl.mockReset();
  whoamiImpl.mockResolvedValue({ user_id: '@bot:localhost' });
  loginImpl.mockReset();
  loginImpl.mockResolvedValue({ access_token: 'fresh-token' });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

function makeDef(id: string, slug: string): AgentDefinition {
  return {
    id, name: slug, slug, version: '1.0',
    runtime: 'declarative', systemPrompt: 'p',
    defaultTools: [], source: 'custom', description: 'd', iconEmoji: '🤖',
    defaultMcps: [], defaultSkills: [],
    workspaceId: null, modelProviderId: 'prov-1', modelName: 'gpt-4o',
    taskDriven: false,
  };
}

/** 直接 INSERT assignment 行（绕过 crud.assignAgentToWorkspace 的 token 注册流程），
 *  用 enabled + last_running 精确控制被测条件。 */
function insertAssignment(
  instanceId: string,
  workspaceId: string,
  defId: string,
  botUserId: string,
  enabled: number,
  lastRunning: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO agent_assignments
        (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role)
       VALUES (?, ?, ?, ?, ?, ?, 'standalone')`,
    )
    .run(instanceId, workspaceId, defId, botUserId, enabled, lastRunning);
}

describe('autoStartAgents: last_running 过滤', () => {
  it('启动 enabled=1 AND last_running=1 的 agent', async () => {
    saveAgentDefinition(makeDef('def-up', 'up'));
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws1'), iconEmoji: '📁' },
      '@o:localhost', '!s1:localhost', '!t1:localhost',
    );
    insertAssignment('inst-up', ws.id, 'def-up', '@bot.up:localhost', 1, 1);
    memStore.set('provider.prov-1.api_key', 'llm-key');
    memStore.set('bot.@bot.up:localhost.matrix_token', 'mx-token');

    await autoStartAgents();

    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    const arg = spawnAgentMock.mock.calls[0]![0] as { instanceId: string };
    expect(arg.instanceId).toBe('inst-up');
  });

  it('跳过 last_running=0 的 agent（用户主动下线）', async () => {
    saveAgentDefinition(makeDef('def-down', 'down'));
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws2'), iconEmoji: '📁' },
      '@o:localhost', '!s2:localhost', '!t2:localhost',
    );
    insertAssignment('inst-down', ws.id, 'def-down', '@bot.down:localhost', 1, 0);
    memStore.set('provider.prov-1.api_key', 'llm-key');
    memStore.set('bot.@bot.down:localhost.matrix_token', 'mx-token');

    await autoStartAgents();

    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('混合状态：只启动 last_running=1 的，跳过 last_running=0 的', async () => {
    saveAgentDefinition(makeDef('def-a', 'a'));
    saveAgentDefinition(makeDef('def-b', 'b'));
    saveAgentDefinition(makeDef('def-c', 'c'));
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws3'), iconEmoji: '📁' },
      '@o:localhost', '!s3:localhost', '!t3:localhost',
    );
    // A: 应启动；B: 主动下线跳过；C: 应启动
    insertAssignment('inst-a', ws.id, 'def-a', '@bot.a:localhost', 1, 1);
    insertAssignment('inst-b', ws.id, 'def-b', '@bot.b:localhost', 1, 0);
    insertAssignment('inst-c', ws.id, 'def-c', '@bot.c:localhost', 1, 1);
    memStore.set('provider.prov-1.api_key', 'llm-key');
    memStore.set('bot.@bot.a:localhost.matrix_token', 'ta');
    memStore.set('bot.@bot.b:localhost.matrix_token', 'tb');
    memStore.set('bot.@bot.c:localhost.matrix_token', 'tc');

    await autoStartAgents();

    expect(spawnAgentMock).toHaveBeenCalledTimes(2);
    const ids = spawnAgentMock.mock.calls.map((c) => (c[0] as { instanceId: string }).instanceId);
    expect(ids.sort()).toEqual(['inst-a', 'inst-c']);
  });

  it('已在运行的 agent（isV1SubprocessAlive=true）不重复 spawn', async () => {
    saveAgentDefinition(makeDef('def-running', 'running'));
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws4'), iconEmoji: '📁' },
      '@o:localhost', '!s4:localhost', '!t4:localhost',
    );
    insertAssignment('inst-running', ws.id, 'def-running', '@bot.r:localhost', 1, 1);
    memStore.set('provider.prov-1.api_key', 'llm-key');
    memStore.set('bot.@bot.r:localhost.matrix_token', 'mx-token');
    isV1SubprocessAliveMock.mockImplementation(() => true);

    await autoStartAgents();

    expect(spawnAgentMock).not.toHaveBeenCalled();
  });
});

describe('autoStartAgents: token 预验证', () => {
  it('whoami 成功时正常 spawn', async () => {
    saveAgentDefinition(makeDef('def-ok', 'ok'));
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ok'), iconEmoji: '📁' },
      '@o:localhost', '!sok:localhost', '!tok:localhost',
    );
    insertAssignment('inst-ok', ws.id, 'def-ok', '@bot.ok:localhost', 1, 1);
    memStore.set('provider.prov-1.api_key', 'llm-key');
    memStore.set('bot.@bot.ok:localhost.matrix_token', 'mx-token');
    whoamiImpl.mockResolvedValue({ user_id: '@bot.ok:localhost' });

    await autoStartAgents();

    expect(whoamiImpl).toHaveBeenCalledTimes(1);
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
  });

  it('whoami 抛 M_UNKNOWN_TOKEN 时不 spawn（避免崩溃循环）', async () => {
    saveAgentDefinition(makeDef('def-stale', 'stale'));
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'stale'), iconEmoji: '📁' },
      '@o:localhost', '!sstale:localhost', '!tstale:localhost',
    );
    insertAssignment('inst-stale', ws.id, 'def-stale', '@bot.stale:localhost', 1, 1);
    memStore.set('provider.prov-1.api_key', 'llm-key');
    memStore.set('bot.@bot.stale:localhost.matrix_token', 'stale-token');
    whoamiImpl.mockRejectedValue(new Error('M_UNKNOWN_TOKEN: Unknown access token.'));

    await autoStartAgents();

    expect(whoamiImpl).toHaveBeenCalledTimes(1);
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('混合：valid token 启动，invalid token 跳过', async () => {
    saveAgentDefinition(makeDef('def-good', 'good'));
    saveAgentDefinition(makeDef('def-bad', 'bad'));
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'mix'), iconEmoji: '📁' },
      '@o:localhost', '!smix:localhost', '!tmix:localhost',
    );
    insertAssignment('inst-good', ws.id, 'def-good', '@bot.good:localhost', 1, 1);
    insertAssignment('inst-bad', ws.id, 'def-bad', '@bot.bad:localhost', 1, 1);
    memStore.set('provider.prov-1.api_key', 'llm-key');
    memStore.set('bot.@bot.good:localhost.matrix_token', 'good-token');
    memStore.set('bot.@bot.bad:localhost.matrix_token', 'bad-token');
    // 按 userId 精确路由（避免 SQL 顺序依赖）
    whoamiImpl.mockImplementation((userId: string) => {
      if (userId === '@bot.bad:localhost') {
        return Promise.reject(new Error('M_UNKNOWN_TOKEN'));
      }
      return Promise.resolve({ user_id: userId });
    });

    await autoStartAgents();

    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    const arg = spawnAgentMock.mock.calls[0]![0] as { instanceId: string };
    expect(arg.instanceId).toBe('inst-good');
  });
});

describe('autoStartAgents: token 失效后 password re-login', () => {
  it('token 失效且有 password → re-login 拿新 token → spawn', async () => {
    saveAgentDefinition(makeDef('def-relogin', 'relogin'));
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'rl'), iconEmoji: '📁' },
      '@o:localhost', '!srl:localhost', '!trl:localhost',
    );
    insertAssignment('inst-relogin', ws.id, 'def-relogin', '@bot.rl:localhost', 1, 1);
    memStore.set('provider.prov-1.api_key', 'llm-key');
    memStore.set('bot.@bot.rl:localhost.matrix_token', 'stale-token');
    memStore.set('bot.@bot.rl:localhost.matrix_password', 'the-password');

    whoamiImpl.mockRejectedValue(new Error('M_UNKNOWN_TOKEN'));
    loginImpl.mockResolvedValue({ access_token: 'new-token-from-login' });

    await autoStartAgents();

    expect(loginImpl).toHaveBeenCalledWith('m.login.password', {
      user: 'bot.rl',  // bot localpart（去 @ 和 :localhost）
      password: 'the-password',
      initial_device_display_name: 'Momo Studio Agent Bot',
    });
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    const arg = spawnAgentMock.mock.calls[0]![0] as { botAccessToken: string };
    expect(arg.botAccessToken).toBe('new-token-from-login');
    expect(memStore.get('bot.@bot.rl:localhost.matrix_token')).toBe('new-token-from-login');
  });

  it('token 失效但无 password（v1.5.8 前老 bot）→ 跳过 spawn', async () => {
    saveAgentDefinition(makeDef('def-nopw', 'nopw'));
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'np'), iconEmoji: '📁' },
      '@o:localhost', '!snp:localhost', '!tnp:localhost',
    );
    insertAssignment('inst-nopw', ws.id, 'def-nopw', '@bot.np:localhost', 1, 1);
    memStore.set('provider.prov-1.api_key', 'llm-key');
    memStore.set('bot.@bot.np:localhost.matrix_token', 'stale');
    // 不设 password（模拟 v1.5.8 前注册的 bot）

    whoamiImpl.mockRejectedValue(new Error('M_UNKNOWN_TOKEN'));

    await autoStartAgents();

    expect(loginImpl).not.toHaveBeenCalled();
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('token 失效 + re-login 也失败（password 错） → 跳过 spawn', async () => {
    saveAgentDefinition(makeDef('def-badpw', 'badpw'));
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'bp'), iconEmoji: '📁' },
      '@o:localhost', '!sbp:localhost', '!tbp:localhost',
    );
    insertAssignment('inst-badpw', ws.id, 'def-badpw', '@bot.bp:localhost', 1, 1);
    memStore.set('provider.prov-1.api_key', 'llm-key');
    memStore.set('bot.@bot.bp:localhost.matrix_token', 'stale');
    memStore.set('bot.@bot.bp:localhost.matrix_password', 'wrong-password');

    whoamiImpl.mockRejectedValue(new Error('M_UNKNOWN_TOKEN'));
    loginImpl.mockRejectedValue(new Error('M_FORBIDDEN: Invalid password'));

    await autoStartAgents();

    expect(loginImpl).toHaveBeenCalled();
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });
});

/**
 * Task 2 review C1 修复验证：直接调 isV1SubprocessAlive。
 *
 * 本文件顶部 vi.mock 替换了整个 runtime-manager 模块（仅暴露 spawnAgent 与 isV1SubprocessAlive），
 * 所以这里用 vi.importActual 取出真实模块的 isV1SubprocessAlive，绕过 mock。
 * 验证函数存在 + runtimes Map 空时返回 false。
 */
describe('isV1SubprocessAlive (Task 2 fix C1)', () => {
  it('runtimes Map 为空时返回 false', async () => {
    const actual = await vi.importActual<typeof import('../../src/main/agent/runtime-manager')>(
      '../../src/main/agent/runtime-manager',
    );
    // runtimes Map 在模块初始化时为空；任何 id 都应返回 false
    expect(actual.isV1SubprocessAlive('inst-not-in-map')).toBe(false);
    expect(actual.isV1SubprocessAlive('any-id')).toBe(false);
  });
});
