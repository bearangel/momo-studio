// electron/tests/agent/runtime-registry.test.ts
//
// runtime-registry 模块测试——覆盖 task-driven runtime 全局注册表的核心函数：
//   1. findAssignmentByBotUserId：按 bot_matrix_user_id 反查 instance_id（DB 查询）
//   2. startAgentRuntime(taskDriven=false)：走 v1 spawnAgent fallback
//   3. startAgentRuntime(taskDriven=true)：创建 WarmPool + AgentRunner + 注册到全局 Map
//   4. createTaskDrivenRuntime：幂等性（重复调用不重建）
//   5. destroyAllTaskDrivenRuntimes：清空全部 Map

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';

// mock runtime-manager（避免真实 spawn + handleStreamChunk 副作用）
vi.mock('../../src/main/agent/runtime-manager', () => ({
  spawnAgent: vi.fn(),
  handleStreamChunk: vi.fn(),
}));

// mock runtime-spawner（避免真实 fork 子进程）
vi.mock('../../src/main/agent/runtime-spawner', () => ({
  spawnForAgent: vi.fn().mockResolvedValue({
    child: {
      kill: vi.fn(),
      pid: 12345,
      on: vi.fn(),
      send: vi.fn(),
      connected: true,
    } as unknown as ChildProcess,
    assignmentId: '',
    spawnedAt: Date.now(),
  }),
}));

import { spawnAgent } from '../../src/main/agent/runtime-manager';
import { spawnForAgent } from '../../src/main/agent/runtime-spawner';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createWorkspace } from '../../src/main/workspace/crud';
import { saveAgentDefinition, assignAgentToWorkspace } from '../../src/main/agent/crud';
import {
  agentRunners,
  agentWarmPools,
  providerBuckets,
  startAgentRuntime,
  createTaskDrivenRuntime,
  findAssignmentByBotUserId,
  populateProviderBuckets,
  destroyAllTaskDrivenRuntimes,
  __clearRuntimeRegistryForTest,
} from '../../src/main/agent/runtime-registry';
import type { AgentRuntimeOpts } from '../../src/main/agent/runtime-manager';
import type { AgentDefinition } from '../../src/main/agent/types';

const tmpRoot = path.join(os.tmpdir(), `ap-runtime-registry-${Date.now()}`);

function mkMinimalOpts(instanceId: string, botUserId: string): AgentRuntimeOpts {
  return {
    instanceId,
    botUserId,
    workspaceId: 'ws-1',
    workspaceDir: '/tmp',
    teamRoomId: '!room:home',
    ownerUserId: '@owner:home',
    agentDefinitionId: 'def-1',
    slug: 'test-agent',
    systemPrompt: '',
    modelProvider: { platform: 'openai', baseUrl: 'http://localhost', apiKey: 'k', model: 'm' },
    botAccessToken: 'tok',
    llmApiKey: 'k',
    role: 'standalone',
    subAgents: [],
    mcpServers: [],
    skills: [],
    allowedTools: [],
    maxToolCalls: 10,
    isCoordinator: false,
    taskDriven: true,
  } as unknown as AgentRuntimeOpts;
}

function mkDef(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'def-1',
    name: 'Test',
    slug: 'test-agent',
    version: '1.0.0',
    runtime: 'nodejs',
    systemPrompt: '',
    defaultTools: [],
    source: 'custom',
    defaultMcps: [],
    defaultSkills: [],
    modelProviderId: 'prov-1',
    modelName: 'gpt-4',
    taskDriven: true,
    ...overrides,
  } as unknown as AgentDefinition;
}

describe('runtime-registry', () => {
  beforeEach(() => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
    __clearRuntimeRegistryForTest();
    vi.mocked(spawnAgent).mockClear();
    vi.mocked(spawnForAgent).mockClear();
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('findAssignmentByBotUserId', () => {
    it('按 bot_matrix_user_id 反查到 instance_id', async () => {
      const ws = await createWorkspace(
        { name: 'WS', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
        '@u:localhost', '!s:localhost', '!t:localhost',
      );
      saveAgentDefinition(mkDef({ id: 'def-x' }));
      const assignment = assignAgentToWorkspace(ws.id, 'def-x', '@bot-xyz:localhost', 'standalone');

      const found = findAssignmentByBotUserId('@bot-xyz:localhost');
      expect(found).toBe(assignment.instanceId);
    });

    it('未找到时返回 null', () => {
      expect(findAssignmentByBotUserId('@nonexistent:localhost')).toBeNull();
    });
  });

  describe('startAgentRuntime', () => {
    it('taskDriven=false 走 v1 spawnAgent', async () => {
      const opts = mkMinimalOpts('inst-v1', '@bot-v1:home');
      await startAgentRuntime(opts, false);

      expect(spawnAgent).toHaveBeenCalledWith(opts);
      expect(agentRunners.has('inst-v1')).toBe(false);
      expect(agentWarmPools.has('inst-v1')).toBe(false);
    });

    it('taskDriven=true 创建 WarmPool + AgentRunner 并注册到全局 Map', async () => {
      const opts = mkMinimalOpts('inst-td', '@bot-td:home');
      await startAgentRuntime(opts, true);

      expect(spawnAgent).not.toHaveBeenCalled();
      expect(agentRunners.has('inst-td')).toBe(true);
      expect(agentWarmPools.has('inst-td')).toBe(true);
      expect(spawnForAgent).toHaveBeenCalled();
    });

    it('taskDriven=true 幂等：重复调用不重建已存在的 pool/runner', async () => {
      const opts = mkMinimalOpts('inst-td2', '@bot-td2:home');
      await startAgentRuntime(opts, true);
      const runnerBefore = agentRunners.get('inst-td2');
      await startAgentRuntime(opts, true);
      const runnerAfter = agentRunners.get('inst-td2');

      expect(runnerAfter).toBe(runnerBefore);
    });
  });

  describe('createTaskDrivenRuntime', () => {
    it('创建 pool + runner 并注册；重复调用返回同一 pool', () => {
      const opts = mkMinimalOpts('inst-ctr', '@bot-ctr:home');
      const pool1 = createTaskDrivenRuntime(opts);
      const pool2 = createTaskDrivenRuntime(opts);

      expect(pool1).toBe(pool2);
      expect(agentRunners.has('inst-ctr')).toBe(true);
      expect(agentWarmPools.has('inst-ctr')).toBe(true);
    });
  });

  describe('destroyAllTaskDrivenRuntimes', () => {
    it('清空全部 Map', async () => {
      const opts = mkMinimalOpts('inst-dest', '@bot-dest:home');
      await startAgentRuntime(opts, true);
      expect(agentRunners.size).toBeGreaterThan(0);

      destroyAllTaskDrivenRuntimes();
      expect(agentRunners.size).toBe(0);
      expect(agentWarmPools.size).toBe(0);
    });
  });

  describe('populateProviderBuckets', () => {
    function insertProvider(id: string, maxRpm: number | null, maxTpm: number | null): void {
      getDb()
        .prepare(
          `INSERT INTO model_providers (id, name, base_url, api_key_ref, max_rpm, max_tpm)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, id, 'http://localhost', 'ref', maxRpm, maxTpm);
    }

    it('为有 max_rpm/max_tpm 的 provider 创建桶', () => {
      insertProvider('prov-rpm', 60, null);
      insertProvider('prov-tpm', null, 10000);
      insertProvider('prov-both', 30, 5000);

      populateProviderBuckets();

      expect(providerBuckets.has('prov-rpm')).toBe(true);
      expect(providerBuckets.has('prov-tpm')).toBe(true);
      expect(providerBuckets.has('prov-both')).toBe(true);
    });

    it('max_rpm 和 max_tpm 都为 NULL 的 provider 不创建桶', () => {
      insertProvider('prov-unlimited', null, null);

      populateProviderBuckets();

      expect(providerBuckets.has('prov-unlimited')).toBe(false);
    });

    it('幂等：重复调用不覆盖已存在的桶', () => {
      insertProvider('prov-idem', 100, null);
      populateProviderBuckets();
      const bucket1 = providerBuckets.get('prov-idem');

      populateProviderBuckets();
      const bucket2 = providerBuckets.get('prov-idem');

      expect(bucket1).toBe(bucket2);
    });
  });
});
