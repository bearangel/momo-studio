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

// mock runtime-manager：捕获 spawnAgent / isAgentRunning 调用，避免 fork 真实子进程
const { spawnAgentMock, isAgentRunningMock } = vi.hoisted(() => ({
  spawnAgentMock: vi.fn(),
  isAgentRunningMock: vi.fn(() => false),
}));

vi.mock('../../src/main/agent/runtime-manager', () => ({
  spawnAgent: spawnAgentMock,
  isAgentRunning: isAgentRunningMock,
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
  isAgentRunningMock.mockImplementation(() => false);
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

  it('已在运行的 agent（isAgentRunning=true）不重复 spawn', async () => {
    saveAgentDefinition(makeDef('def-running', 'running'));
    const ws = await createWorkspace(
      { name: 'w', description: '', directoryPath: path.join(tmpRoot, 'ws4'), iconEmoji: '📁' },
      '@o:localhost', '!s4:localhost', '!t4:localhost',
    );
    insertAssignment('inst-running', ws.id, 'def-running', '@bot.r:localhost', 1, 1);
    memStore.set('provider.prov-1.api_key', 'llm-key');
    memStore.set('bot.@bot.r:localhost.matrix_token', 'mx-token');
    isAgentRunningMock.mockImplementation(() => true);

    await autoStartAgents();

    expect(spawnAgentMock).not.toHaveBeenCalled();
  });
});
