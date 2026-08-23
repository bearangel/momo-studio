// electron/tests/agent/runtime-manager-restart.test.ts
//
// 崩溃自动重启 + circuit breaker 单元测试。用 fake-runtime-crash.ts 模拟立即
// 崩溃的子进程，配合 setRestartDelaysOverride 把延迟压到 10ms，使整个
// 崩溃→重启→再崩溃→circuit breaker 流程在毫秒级完成。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  spawnAgent,
  stopAgent,
  stopAllAgents,
  isAgentRunning,
  getRestartCount,
  hasPendingRestart,
  resetRestartCount,
  setRestartDelaysOverride,
  setRuntimeEntryOverride,
  __resetRestartState,
  type AgentRuntimeOpts,
} from '../../src/main/agent/runtime-manager';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { createWorkspace } from '../../src/main/workspace/crud';
import { saveAgentDefinition } from '../../src/main/agent/crud';
import type { AgentDefinition } from '../../src/main/agent/types';

const fakeCrash = path.join(__dirname, 'fake-runtime-crash.ts');
const tmpRoot = path.join(os.tmpdir(), `ap-rt-restart-${Date.now()}-${process.pid}`);

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
    botUserId,
    botAccessToken: 'tok',
    homeserverUrl: 'http://127.0.0.1:8008',
    systemPrompt: '',
    modelProvider: 'openai',
    modelName: 'gpt-4o',
    llmApiKey: 'key',
    teamRoomId: '!room:localhost',
    ownerUserId: '@owner:localhost',
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
 * 插入 assignment 行（指定 last_running）。
 * v2：isAgentRunning 查 DB last_running，所以测试需要预置 DB 行才能验证
 * "spawn 后 isAgentRunning=true" 和 "stopAgent 后 isAgentRunning=false"。
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

/** 轮询等待条件满足或超时（处理真实子进程退出的异步时序） */
async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）`);
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
  setRuntimeEntryOverride(['node', '--import', 'tsx', fakeCrash]);
  setRestartDelaysOverride([10, 10, 10]);
  delete process.env.AP_FAKE_EXIT_CODE;
  delete process.env.AP_FAKE_DELAY_MS;
});

afterEach(() => {
  stopAllAgents();
  __resetRestartState();
  setRuntimeEntryOverride(null);
  setRestartDelaysOverride(null);
  delete process.env.AP_FAKE_EXIT_CODE;
  delete process.env.AP_FAKE_DELAY_MS;
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

describe('agent/runtime-manager 崩溃重启', () => {
  it('崩溃后自动重启，达到 3 次后 circuit breaker 暂停', async () => {
    // v2：isAgentRunning 查 DB last_running。spawn 后 DB 写 1，但崩溃/circuit breaker
    // 不改 DB（用户启动意图不变）。原断言 `!isAgentRunning` 在新语义下不再适用，
    // 改为直接读 DB 确认用户启动意图未变。
    seedAssignment('crash-1', '@bot.crash-1:localhost', 1);
    spawnAgent(makeOpts('crash-1', '@bot.crash-1:localhost'));

    // 等待 circuit breaker 稳定：count >= 3 且无挂起重启
    // （count=3 + hasPendingRestart=true 是中间态——最后一次重启还在排队；
    //   count=3 + hasPendingRestart=false 是终态——circuit breaker 已触发）
    await waitFor(
      () =>
        getRestartCount('crash-1') >= 3 &&
        !hasPendingRestart('crash-1'),
      15000,
    );
    expect(getRestartCount('crash-1')).toBe(3);
    // 用户启动意图未变（DB last_running 仍为 1）
    expect(isAgentRunning('crash-1')).toBe(true);
  });

  it('正常退出（code=0）不触发重启', async () => {
    // v2：seed assignment 后 isAgentRunning 才有意义。
    // 进程正常退出后 runtimes Map 清空，但 DB last_running 仍为 1
    // （exit handler 不主动改 DB——用户未手动 stop）。
    seedAssignment('exit0-1', '@bot.exit0-1:localhost', 1);
    process.env.AP_FAKE_EXIT_CODE = '0';
    spawnAgent(makeOpts('exit0-1', '@bot.exit0-1:localhost'));

    // 等 handleAgentExit 跑完（code=0 路径直接 return，不重启）
    await waitFor(() => getRestartCount('exit0-1') === 0, 2000);
    // 等一会确保没有重启
    await new Promise((r) => setTimeout(r, 50));
    expect(getRestartCount('exit0-1')).toBe(0);
    // 用户启动意图未变（DB last_running 仍为 1）
    expect(isAgentRunning('exit0-1')).toBe(true);
  });

  it('stopAgent 主动停止后即使 code≠0 也不重启', async () => {
    // v2：seed assignment 后 isAgentRunning=true；stopAgent 写 last_running=0。
    // 存活 5s 但收到 SIGTERM 时以 code=1 退出
    seedAssignment('stop-1', '@bot.stop-1:localhost', 1);
    process.env.AP_FAKE_EXIT_CODE = '1';
    process.env.AP_FAKE_DELAY_MS = '5000';
    spawnAgent(makeOpts('stop-1', '@bot.stop-1:localhost'));

    await waitFor(() => isAgentRunning('stop-1'), 2000);
    stopAgent('stop-1');

    // 等待 exit 事件传播 + stopAgent 写 last_running=0
    await waitFor(() => !isAgentRunning('stop-1'), 2000);
    // 即使 exit code=1，因为是主动停止，不应触发重启
    await new Promise((r) => setTimeout(r, 100));
    expect(getRestartCount('stop-1')).toBe(0);
    expect(isAgentRunning('stop-1')).toBe(false);
  });

  it('resetRestartCount 清除计数和挂起的定时器', async () => {
    seedAssignment('reset-1', '@bot.reset-1:localhost', 1);
    spawnAgent(makeOpts('reset-1', '@bot.reset-1:localhost'));
    // 等到至少重启一次
    await waitFor(() => getRestartCount('reset-1') >= 1, 3000);

    resetRestartCount('reset-1');
    expect(getRestartCount('reset-1')).toBe(0);

    // 停止所有进程（可能有一个正在重启的 timer 里）
    stopAllAgents();
  });
});