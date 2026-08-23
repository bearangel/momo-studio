// electron/tests/agent/runtime-manager.test.ts
//
// runtime-manager 单元测试：用 fake-runtime.ts 作为子进程入口（通过
// setRuntimeEntryOverride），验证进程池的 spawn/stop/isRunning 生命周期。
// 不测真实 runtime-entry（需要真实 Matrix 环境）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  spawnAgent,
  stopAgent,
  stopAllAgents,
  isAgentRunning,
  setRuntimeEntryOverride,
  type AgentRuntimeOpts,
} from '../../src/main/agent/runtime-manager';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { createWorkspace } from '../../src/main/workspace/crud';
import { saveAgentDefinition } from '../../src/main/agent/crud';
import type { AgentDefinition } from '../../src/main/agent/types';

const fakeRuntime = path.join(__dirname, 'fake-runtime.ts');
const tmpRoot = path.join(os.tmpdir(), `ap-rt-${Date.now()}-${process.pid}`);

const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};

let wsId: string;

function makeOpts(instanceId: string, botUserId: string): AgentRuntimeOpts {
  return {
    instanceId,
    workspaceId: wsId,
    workspaceDir: '/tmp',
    agentUserId: botUserId,
    agentAssignmentId: instanceId,
    systemPrompt: '',
    modelProvider: 'openai',
    modelName: 'gpt-4o',
    llmApiKey: 'key',
    teamSessionId: '!room:localhost',
  };
}

function makeDef(id: string): AgentDefinition {
  return {
    id,
    name: id,
    slug: id,
    version: '1',
    runtime: 'declarative',
    systemPrompt: '',
    defaultTools: [],
    source: 'custom',
    description: '',
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: 'prov-1',
    modelName: 'gpt-4o',
  };
}

/**
 * 插入 assignment 行（last_running 由调用方指定）。
 * 用 SQL 而非 assignAgentToWorkspace helper，因为后者不暴露 last_running 参数；
 * 现有 schema 要求 column 齐全（v1.3 加 role/parent/has_api_key_override，v1.5.8 加 last_running）。
 */
function seedAssignment(instanceId: string, botUserId: string, lastRunning: 0 | 1): void {
  getDb()
    .prepare(
      `INSERT INTO agent_assignments
        (instance_id, workspace_id, agent_definition_id, agent_user_id,
         enabled, last_running, role, parent_instance_id, has_api_key_override)
       VALUES (?, ?, ?, ?, 1, ?, 'standalone', NULL, 0)`,
    )
    .run(instanceId, wsId, 'def-x', botUserId, lastRunning);
}

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
  const ws = await createWorkspace(
    { name: 'WS', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
    '@u:localhost', '!s:localhost', '!t:localhost',
  );
  wsId = ws.id;
  saveAgentDefinition(makeDef('def-x'));
  setRuntimeEntryOverride(['node', '--import', 'tsx', fakeRuntime]);
});

afterEach(() => {
  stopAllAgents();
  setRuntimeEntryOverride(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

describe('agent/runtime-manager', () => {
  it('spawnAgent 启动子进程并注册到进程池', () => {
    const instId = 'inst-1';
    const bot = '@bot.inst-1:localhost';
    seedAssignment(instId, bot, 0);
    expect(isAgentRunning(instId)).toBe(false);
    spawnAgent(makeOpts(instId, bot));
    expect(isAgentRunning(instId)).toBe(true);
  });

  it('stopAgent 停止子进程并从进程池移除', () => {
    const instId = 'inst-2';
    const bot = '@bot.inst-2:localhost';
    seedAssignment(instId, bot, 0);
    spawnAgent(makeOpts(instId, bot));
    expect(isAgentRunning(instId)).toBe(true);
    stopAgent(instId);
    expect(isAgentRunning(instId)).toBe(false);
  });

  it('stopAgent 对未知 instanceId 是 no-op', () => {
    expect(() => stopAgent('does-not-exist')).not.toThrow();
  });

  it('stopAllAgents 清空进程池', () => {
    const ids = ['a', 'b', 'c'] as const;
    for (const id of ids) seedAssignment(id, `@bot.${id}:localhost`, 0);
    spawnAgent(makeOpts('a', '@bot.a:localhost'));
    spawnAgent(makeOpts('b', '@bot.b:localhost'));
    spawnAgent(makeOpts('c', '@bot.c:localhost'));
    expect(isAgentRunning('a')).toBe(true);
    expect(isAgentRunning('b')).toBe(true);
    expect(isAgentRunning('c')).toBe(true);

    stopAllAgents();

    expect(isAgentRunning('a')).toBe(false);
    expect(isAgentRunning('b')).toBe(false);
    expect(isAgentRunning('c')).toBe(false);
  });

  it('不同 instanceId 互不影响', () => {
    seedAssignment('x', '@bot.x:localhost', 0);
    seedAssignment('y', '@bot.y:localhost', 0);
    spawnAgent(makeOpts('x', '@bot.x:localhost'));
    spawnAgent(makeOpts('y', '@bot.y:localhost'));
    stopAgent('x');
    expect(isAgentRunning('x')).toBe(false);
    expect(isAgentRunning('y')).toBe(true);
  });
});

/**
 * Task 2：isAgentRunning 新语义——查询 DB last_running 字段（用户启动意图），
 * 不再查 v1 runtimes Map。这样 task-driven agent 即使不在 runtimes Map 里
 * 也能正确返回 true（只要 DB 标记为 running）。
 */
describe('isAgentRunning DB 查询行为 (Task 2)', () => {
  it('last_running=1 → 返回 true（无论 runtimes Map 是否有 entry）', () => {
    const instId = 'inst-isrunning-1';
    const bot = '@bot.isrunning-1:localhost';
    seedAssignment(instId, bot, 1);

    // 不调用 spawnAgent — runtimes Map 不含此 instId（模拟 task-driven agent）
    expect(isAgentRunning(instId)).toBe(true);
  });

  it('last_running=0 → 返回 false', () => {
    const instId = 'inst-isrunning-0';
    const bot = '@bot.isrunning-0:localhost';
    seedAssignment(instId, bot, 0);

    expect(isAgentRunning(instId)).toBe(false);
  });

  it('instanceId 不存在 → 返回 false', () => {
    expect(isAgentRunning('inst-not-exist')).toBe(false);
  });
});