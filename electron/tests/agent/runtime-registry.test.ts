// electron/tests/agent/runtime-registry.test.ts
//
// runtime-registry 模块测试——覆盖 task-driven runtime 全局注册表的核心函数：

//   1. startAgentRuntime：创建 WarmPool + AgentRunner + 注册到全局 Map（幂等）
//   2. createTaskDrivenRuntime：幂等性（重复调用不重建）
//   3. destroyAllTaskDrivenRuntimes：清空全部 Map
//   4. destroyTaskDrivenRuntime：销毁单 agent 的 runner + WarmPool
//   5. stopAgentRuntime：销毁 runtime + DB last_running=0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';

// mock runtime-spawner（避免真实 fork 子进程）——mock child 按真实语义
// 构造（运行中 exitCode === null / connected === true，含 off 反注册）
vi.mock('../../src/main/agent/runtime-spawner', () => ({
  spawnForAgent: vi.fn(),
}));

// mock router-bootstrap（Task R2：避免真实启动 RouterService；
// 仅验证 ensureTaskDrivenRuntime 是否调用了 ensureRouterService）
vi.mock('../../src/main/agent/router-bootstrap', () => ({
  ensureRouterService: vi.fn().mockResolvedValue(undefined),
  destroyRouterService: vi.fn(),
  __resetRouterServiceForTest: vi.fn(),
}));

import { spawnForAgent, type SpawnOpts } from '../../src/main/agent/runtime-spawner';
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
  populateProviderBuckets,
  destroyAllTaskDrivenRuntimes,
  destroyTaskDrivenRuntime,
  stopAgentRuntime,
  __clearRuntimeRegistryForTest,
} from '../../src/main/agent/runtime-registry';
import type { AgentRuntimeOpts } from '../../src/main/agent/runtime-config';
import type { AgentDefinition } from '../../src/main/agent/types';
import type { AgentRunner } from '../../src/main/agent/agent-runner';
import type { WarmPool } from '../../src/main/agent/warm-pool';
import type { ChildProcess } from 'node:child_process';

/** 构造仿真存活语义的 mock child（运行中：connected=true / exitCode=null） */
function mkSpawnChild(): ChildProcess {
  return {
    kill: vi.fn(),
    pid: 12345,
    on: vi.fn(),
    off: vi.fn(),
    send: vi.fn(),
    connected: true,
    exitCode: null,
  } as unknown as ChildProcess;
}

const tmpRoot = path.join(os.tmpdir(), `ap-runtime-registry-${Date.now()}`);

function mkMinimalOpts(instanceId: string, agentUserId: string): AgentRuntimeOpts {
  return {
    instanceId,
    agentAssignmentId: instanceId,
    agentUserId,
    workspaceId: 'ws-1',
    workspaceDir: '/tmp',
    teamSessionId: 'sess-team-1',
    agentDefinitionId: 'def-1',
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
    // 默认实现：每次 spawn 返回全新 mock child（避免跨用例共享可变 spy）
    vi.mocked(spawnForAgent).mockReset();
    vi.mocked(spawnForAgent).mockImplementation(async (opts: SpawnOpts) => ({
      child: mkSpawnChild(),
      assignmentId: opts.assignmentId,
      spawnedAt: Date.now(),
    }));
    vi.mocked(ensureRouterService).mockClear();
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('startAgentRuntime（单轨）', () => {
    it('创建 WarmPool + AgentRunner 并注册到全局 Map', async () => {
      const opts = mkMinimalOpts('inst-td', '@bot-td:home');
      await startAgentRuntime(opts);

      expect(agentRunners.has('inst-td')).toBe(true);
      expect(agentWarmPools.has('inst-td')).toBe(true);
      expect(spawnForAgent).toHaveBeenCalled();
    });

    it('幂等：重复调用不重建已存在的 pool/runner', async () => {
      const opts = mkMinimalOpts('inst-td2', '@bot-td2:home');
      await startAgentRuntime(opts);
      const runnerBefore = agentRunners.get('inst-td2');
      await startAgentRuntime(opts);
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
      await startAgentRuntime(opts);
      expect(agentRunners.size).toBeGreaterThan(0);

      destroyAllTaskDrivenRuntimes();
      expect(agentRunners.size).toBe(0);
      expect(agentWarmPools.size).toBe(0);
    });
  });

  describe('ensureTaskDrivenRuntime 触发 ensureRouterService (Task R2)', () => {
    it('创建新 runner 后调用 ensureRouterService（单参数：仅 runners Map 引用）', async () => {
      const opts = mkMinimalOpts('inst-r2-1', '@bot-r2-1:home');
      await startAgentRuntime(opts);

      expect(ensureRouterService).toHaveBeenCalledOnce();
      // 验证传入的是 Map 引用（应使用 runtime-registry 的全局 agentRunners；
      // spec §9 后 providerBuckets 不再传入——它只服务于已砍除的 dispatcher）
      const call = vi.mocked(ensureRouterService).mock.calls[0];
      expect(call).toHaveLength(1);
      expect(call[0]).toBe(agentRunners);
    });

    it('runner 已存在时（幂等调用）不再触发 ensureRouterService', async () => {
      const opts = mkMinimalOpts('inst-r2-2', '@bot-r2-2:home');
      await startAgentRuntime(opts);  // 首次：创建 runner + 触发 ensureRouterService
      vi.mocked(ensureRouterService).mockClear();

      await startAgentRuntime(opts);  // 二次：pool 已存在，跳过 ensure 块
      expect(ensureRouterService).not.toHaveBeenCalled();
    });
  });

  describe('C2：child exit 清理链（onExit → 池剔除 + runner 收尾）', () => {
    it('子进程退出 → 从 WarmPool 剔除该 child（僵尸池条目不再可被 acquire）', async () => {
      // 记录每次 spawn 的 opts（含 onExit 回调）与产出的 child 身份
      const spawned: Array<{ opts: SpawnOpts; child: ChildProcess }> = [];
      vi.mocked(spawnForAgent).mockImplementation(async (opts: SpawnOpts) => {
        const child = mkSpawnChild();
        child.pid = 5000 + spawned.length;
        spawned.push({ opts, child });
        return { child, assignmentId: opts.assignmentId, spawnedAt: Date.now() };
      });

      const opts = mkMinimalOpts('inst-exit-1', '@bot-exit-1:home');
      await startAgentRuntime(opts);
      const pool = agentWarmPools.get('inst-exit-1')!;
      expect(pool.size('inst-exit-1')).toBe(2); // 预热 2 个

      // 第一个子进程退出（模拟崩溃）→ onExit 清理链触发池剔除
      const first = spawned[0]!;
      first.opts.onExit(1);
      expect(pool.size('inst-exit-1')).toBe(1);

      // 池中剩的应是第二个 child（acquire 验证）
      const rt = await pool.acquire('inst-exit-1');
      expect(rt.child).toBe(spawned[1]!.child);
    });

    it('退出清理对重建后的 pool/runner 幂等（旧闭包不误伤新实例）', async () => {
      const spawnCalls: Array<{ opts: SpawnOpts; child: ChildProcess }> = [];
      vi.mocked(spawnForAgent).mockImplementation(async (opts: SpawnOpts) => {
        const child = mkSpawnChild();
        child.pid = 6000 + spawnCalls.length;
        spawnCalls.push({ opts, child });
        return { child, assignmentId: opts.assignmentId, spawnedAt: Date.now() };
      });

      const opts = mkMinimalOpts('inst-exit-2', '@bot-exit-2:home');
      await startAgentRuntime(opts);
      const stale = spawnCalls[0]!;

      // stop → 重建（新 pool 替换旧 pool），旧 spawn 闭包的 onExit 此时触发
      await stopAgentRuntime('inst-exit-2');
      await startAgentRuntime(opts);
      const newPool = agentWarmPools.get('inst-exit-2')!;
      const sizeBefore = newPool.size('inst-exit-2');

      expect(() => stale.opts.onExit(1)).not.toThrow();
      // 新池的子进程与旧闭包的 child 身份不同 → 不应被误剔除
      expect(newPool.size('inst-exit-2')).toBe(sizeBefore);
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

    it('stopAgentRuntime 销毁 runtime 并写 last_running=0', async () => {
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
