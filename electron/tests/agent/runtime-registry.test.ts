// electron/tests/agent/runtime-registry.test.ts
//
// runtime-registry 模块测试——覆盖 task-driven runtime 全局注册表的核心函数：
//   1. findAssignmentByAgentUserId：按 agent_user_id 反查 instance_id（DB 查询）
//   2. startAgentRuntime(taskDriven=false)：走 v1 spawnAgent fallback
//   3. startAgentRuntime(taskDriven=true)：创建 WarmPool + AgentRunner + 注册到全局 Map
//   4. createTaskDrivenRuntime：幂等性（重复调用不重建）
//   5. destroyAllTaskDrivenRuntimes：清空全部 Map
//   6. destroyTaskDrivenRuntime：销毁单 agent 的 runner + WarmPool
//   7. stopAgentRuntime：v1 stopAgent + v2 destroy + DB last_running=0 三合一

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';

// mock runtime-manager（避免真实 spawn + handleStreamChunk 副作用）
vi.mock('../../src/main/agent/runtime-manager', () => ({
  spawnAgent: vi.fn(),
  handleStreamChunk: vi.fn(),
  stopAgent: vi.fn(),
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

// mock router-bootstrap（Task R2：避免真实启动 RouterService；
// 仅验证 ensureTaskDrivenRuntime 是否调用了 ensureRouterService）
vi.mock('../../src/main/agent/router-bootstrap', () => ({
  ensureRouterService: vi.fn().mockResolvedValue(undefined),
  destroyRouterService: vi.fn(),
  __resetRouterServiceForTest: vi.fn(),
}));

import { spawnAgent, stopAgent } from '../../src/main/agent/runtime-manager';
import { spawnForAgent } from '../../src/main/agent/runtime-spawner';
import { ensureRouterService } from '../../src/main/agent/router-bootstrap';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createWorkspace } from '../../src/main/workspace/crud';
import { saveAgentDefinition, assignAgentToWorkspace } from '../../src/main/agent/crud';
import {
  agentRunners,
  agentWarmPools,
  providerBuckets,
  startAgentRuntime,
  createTaskDrivenRuntime,
  findAssignmentByAgentUserId,
  populateProviderBuckets,
  destroyAllTaskDrivenRuntimes,
  destroyTaskDrivenRuntime,
  stopAgentRuntime,
  __clearRuntimeRegistryForTest,
} from '../../src/main/agent/runtime-registry';
import type { AgentRuntimeOpts } from '../../src/main/agent/runtime-manager';
import type { AgentDefinition } from '../../src/main/agent/types';
import type { AgentRunner } from '../../src/main/agent/agent-runner';
import type { WarmPool } from '../../src/main/agent/warm-pool';

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
    vi.mocked(stopAgent).mockClear();
    vi.mocked(ensureRouterService).mockClear();
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('findAssignmentByAgentUserId', () => {
    it('按 agent_user_id 反查到 instance_id', async () => {
      const ws = await createWorkspace(
        { name: 'WS', description: '', directoryPath: path.join(tmpRoot, 'ws'), iconEmoji: '📁' },
        '@u:localhost', '!s:localhost', '!t:localhost',
      );
      saveAgentDefinition(mkDef({ id: 'def-x' }));
      const assignment = assignAgentToWorkspace(ws.id, 'def-x', '@bot-xyz:localhost', 'standalone');

      const found = findAssignmentByAgentUserId('@bot-xyz:localhost');
      expect(found).toBe(assignment.instanceId);
    });

    it('未找到时返回 null', () => {
      expect(findAssignmentByAgentUserId('@nonexistent:localhost')).toBeNull();
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

  describe('ensureTaskDrivenRuntime 触发 ensureRouterService (Task R2)', () => {
    it('创建新 runner 后调用 ensureRouterService', async () => {
      const opts = mkMinimalOpts('inst-r2-1', '@bot-r2-1:home');
      await startAgentRuntime(opts, true);

      expect(ensureRouterService).toHaveBeenCalledOnce();
      // 验证传入的是 Map 引用（应使用 runtime-registry 的全局 agentRunners + providerBuckets）
      const call = vi.mocked(ensureRouterService).mock.calls[0];
      expect(call[0]).toBe(agentRunners);
      expect(call[1]).toBe(providerBuckets);
    });

    it('runner 已存在时（幂等调用）不再触发 ensureRouterService', async () => {
      const opts = mkMinimalOpts('inst-r2-2', '@bot-r2-2:home');
      await startAgentRuntime(opts, true);  // 首次：创建 runner + 触发 ensureRouterService
      vi.mocked(ensureRouterService).mockClear();

      await startAgentRuntime(opts, true);  // 二次：pool 已存在，跳过 ensure 块
      expect(ensureRouterService).not.toHaveBeenCalled();
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

  describe('destroyTaskDrivenRuntime + stopAgentRuntime (Task 3)', () => {
    it('destroyTaskDrivenRuntime 移除 runner + pool 并调用 destroy/destroyAll', () => {
      const instId = 'inst-destroy-1';
      const fakeRunner = {
        assignmentId: instId,
        botUserId: '@bot:localhost',
        workspaceId: 'ws-test',
        destroy: vi.fn(),
        executeTask: vi.fn(),
        abortStream: vi.fn(),
        activeTaskCount: vi.fn().mockReturnValue(0),
        notifyTaskReply: vi.fn(),
      } as unknown as AgentRunner;
      const fakePool = {
        warm: vi.fn(),
        acquire: vi.fn(),
        release: vi.fn(),
        size: vi.fn().mockReturnValue(0),
        destroyAll: vi.fn(),
      } as unknown as WarmPool;
      agentRunners.set(instId, fakeRunner);
      agentWarmPools.set(instId, fakePool);

      destroyTaskDrivenRuntime(instId);

      expect(agentRunners.has(instId)).toBe(false);
      expect(agentWarmPools.has(instId)).toBe(false);
      expect(fakeRunner.destroy).toHaveBeenCalledOnce();
      expect(fakePool.destroyAll).toHaveBeenCalledOnce();
    });

    it('destroyTaskDrivenRuntime 对不存在的 instanceId 是 no-op', () => {
      expect(() => destroyTaskDrivenRuntime('inst-not-exist')).not.toThrow();
    });

    it('stopAgentRuntime 调用 v1 stopAgent + v2 destroy + 写 last_running=0', async () => {
      const ws = await createWorkspace(
        { name: 'WS-stop', description: '', directoryPath: path.join(tmpRoot, 'ws-stop'), iconEmoji: '📁' },
        '@u:localhost', '!s:localhost', '!t:localhost',
      );
      saveAgentDefinition(mkDef({ id: 'def-stop' }));
      const assignment = assignAgentToWorkspace(ws.id, 'def-stop', '@bot-stop:localhost', 'standalone');
      const instId = assignment.instanceId;

      const fakeRunner = {
        assignmentId: instId,
        botUserId: '@bot-stop:localhost',
        workspaceId: ws.id,
        destroy: vi.fn(),
        executeTask: vi.fn(),
        abortStream: vi.fn(),
        activeTaskCount: vi.fn(),
        notifyTaskReply: vi.fn(),
      } as unknown as AgentRunner;
      const fakePool = {
        warm: vi.fn(),
        acquire: vi.fn(),
        release: vi.fn(),
        size: vi.fn(),
        destroyAll: vi.fn(),
      } as unknown as WarmPool;
      agentRunners.set(instId, fakeRunner);
      agentWarmPools.set(instId, fakePool);

      await stopAgentRuntime(instId);

      expect(stopAgent).toHaveBeenCalledWith(instId);
      expect(fakeRunner.destroy).toHaveBeenCalledOnce();
      expect(fakePool.destroyAll).toHaveBeenCalledOnce();
      expect(agentRunners.has(instId)).toBe(false);
      expect(agentWarmPools.has(instId)).toBe(false);

      const row = getDb()
        .prepare('SELECT last_running FROM agent_assignments WHERE instance_id = ?')
        .get(instId) as { last_running: number };
      expect(row.last_running).toBe(0);
    });
  });
});
