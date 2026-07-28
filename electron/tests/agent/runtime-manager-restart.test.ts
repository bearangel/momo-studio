// electron/tests/agent/runtime-manager-restart.test.ts
//
// 崩溃自动重启 + circuit breaker 单元测试。用 fake-runtime-crash.ts 模拟立即
// 崩溃的子进程，配合 setRestartDelaysOverride 把延迟压到 10ms，使整个
// 崩溃→重启→再崩溃→circuit breaker 流程在毫秒级完成。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
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

const fakeCrash = path.join(__dirname, 'fake-runtime-crash.ts');

function makeOpts(instanceId: string): AgentRuntimeOpts {
  return {
    instanceId,
    workspaceId: 'ws-restart',
    workspaceDir: '/tmp',
    botUserId: '@bot.restart:localhost',
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

/** 轮询等待条件满足或超时（处理真实子进程退出的异步时序） */
async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）`);
}

describe('agent/runtime-manager 崩溃重启', () => {
  beforeEach(() => {
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
  });

  it('崩溃后自动重启，达到 3 次后 circuit breaker 暂停', async () => {
    spawnAgent(makeOpts('crash-1'));

    // 等待 circuit breaker 稳定：count >= 3 且无挂起重启且无运行中进程
    // （count=3 + hasPendingRestart=true 是中间态——最后一次重启还在排队；
    //   count=3 + hasPendingRestart=false + !running 是终态——circuit breaker 已触发）
    await waitFor(
      () =>
        getRestartCount('crash-1') >= 3 &&
        !hasPendingRestart('crash-1') &&
        !isAgentRunning('crash-1'),
      15000,
    );
    expect(getRestartCount('crash-1')).toBe(3);
    expect(isAgentRunning('crash-1')).toBe(false);
  });

  it('正常退出（code=0）不触发重启', async () => {
    process.env.AP_FAKE_EXIT_CODE = '0';
    spawnAgent(makeOpts('exit0-1'));

    await waitFor(() => !isAgentRunning('exit0-1'), 2000);
    // 等一会确保没有重启
    await new Promise((r) => setTimeout(r, 50));
    expect(isAgentRunning('exit0-1')).toBe(false);
    expect(getRestartCount('exit0-1')).toBe(0);
  });

  it('stopAgent 主动停止后即使 code≠0 也不重启', async () => {
    // 存活 5s 但收到 SIGTERM 时以 code=1 退出
    process.env.AP_FAKE_EXIT_CODE = '1';
    process.env.AP_FAKE_DELAY_MS = '5000';
    spawnAgent(makeOpts('stop-1'));

    await waitFor(() => isAgentRunning('stop-1'), 2000);
    stopAgent('stop-1');

    // 等待 exit 事件传播
    await waitFor(() => !isAgentRunning('stop-1'), 2000);
    // 即使 exit code=1，因为是主动停止，不应触发重启
    await new Promise((r) => setTimeout(r, 100));
    expect(getRestartCount('stop-1')).toBe(0);
    expect(isAgentRunning('stop-1')).toBe(false);
  });

  it('resetRestartCount 清除计数和挂起的定时器', async () => {
    spawnAgent(makeOpts('reset-1'));
    // 等到至少重启一次
    await waitFor(() => getRestartCount('reset-1') >= 1, 3000);

    resetRestartCount('reset-1');
    expect(getRestartCount('reset-1')).toBe(0);

    // 停止所有进程（可能有一个正在重启的 timer 里）
    stopAllAgents();
  });
});
