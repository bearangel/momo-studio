// electron/tests/agent/auto-start-last-running.test.ts
//
// v1.5.8 autoStartAgents 查询测试：验证 enabled=1 AND last_running=1 的过滤逻辑。
// runtime-manager 被 mock（避免 fork）；其余走真实 DB + keychain + crud。
// v2（Task 10）：auto-start 不再解析/验证 bot Matrix token（whoami/re-login
// 流程已随 agent 去 Matrix 一并移除）。

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
        (instance_id, workspace_id, agent_definition_id, agent_user_id, enabled, last_running, role)
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
    isV1SubprocessAliveMock.mockImplementation(() => true);

    await autoStartAgents();

    expect(spawnAgentMock).not.toHaveBeenCalled();
  });
});

describe('autoStartAgents: v2 无 Matrix token 依赖', () => {
  it('keychain 无 bot token 也正常 spawn（Task 10 去 Matrix）', async () => {
    saveAgentDefinition(makeDef('def-notoken', 'notoken'));
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'nt'), iconEmoji: '📁' },
      '@o:localhost',
    );
    insertAssignment('inst-notoken', ws.id, 'def-notoken', 'agent-notoken-x1', 1, 1);
    memStore.set('provider.prov-1.api_key', 'llm-key');
    // 不设任何 bot.* keychain 条目——v2 路径不读 token，直接 spawn

    await autoStartAgents();

    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    const arg = spawnAgentMock.mock.calls[0]![0] as {
      instanceId: string; agentUserId: string; teamSessionId: string;
      botAccessToken?: string;
    };
    expect(arg.instanceId).toBe('inst-notoken');
    expect(arg.agentUserId).toBe('agent-notoken-x1');
    expect(arg.teamSessionId).toBe(ws.teamSessionId);
    expect(arg.botAccessToken).toBeUndefined();
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
