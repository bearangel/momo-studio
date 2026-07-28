// electron/tests/agent/runtime-manager.test.ts
//
// runtime-manager 单元测试：用 fake-runtime.ts 作为子进程入口（通过
// setRuntimeEntryOverride），验证进程池的 spawn/stop/isRunning 生命周期。
// 不测真实 runtime-entry（需要真实 Matrix 环境）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import {
  spawnAgent,
  stopAgent,
  stopAllAgents,
  isAgentRunning,
  setRuntimeEntryOverride,
  type AgentRuntimeOpts,
} from '../../src/main/agent/runtime-manager';

const fakeRuntime = path.join(__dirname, 'fake-runtime.ts');

function makeOpts(instanceId: string): AgentRuntimeOpts {
  return {
    instanceId,
    workspaceId: 'ws-1',
    workspaceDir: '/tmp',
    botUserId: '@bot.test.alice:localhost',
    botAccessToken: 'tok',
    homeserverUrl: 'http://127.0.0.1:8008',
    systemPrompt: '',
    modelProvider: 'openai',
    modelName: 'gpt-4o',
    llmApiKey: 'key',
    teamRoomId: '!room:localhost',
  };
}

describe('agent/runtime-manager', () => {
  beforeEach(() => {
    setRuntimeEntryOverride(['node', '--import', 'tsx', fakeRuntime]);
  });

  afterEach(() => {
    stopAllAgents();
    setRuntimeEntryOverride(null);
  });

  it('spawnAgent 启动子进程并注册到进程池', () => {
    expect(isAgentRunning('inst-1')).toBe(false);
    spawnAgent(makeOpts('inst-1'));
    expect(isAgentRunning('inst-1')).toBe(true);
  });

  it('stopAgent 停止子进程并从进程池移除', () => {
    spawnAgent(makeOpts('inst-2'));
    expect(isAgentRunning('inst-2')).toBe(true);
    stopAgent('inst-2');
    expect(isAgentRunning('inst-2')).toBe(false);
  });

  it('stopAgent 对未知 instanceId 是 no-op', () => {
    expect(() => stopAgent('does-not-exist')).not.toThrow();
  });

  it('stopAllAgents 清空进程池', () => {
    spawnAgent(makeOpts('a'));
    spawnAgent(makeOpts('b'));
    spawnAgent(makeOpts('c'));
    expect(isAgentRunning('a')).toBe(true);
    expect(isAgentRunning('b')).toBe(true);
    expect(isAgentRunning('c')).toBe(true);

    stopAllAgents();

    expect(isAgentRunning('a')).toBe(false);
    expect(isAgentRunning('b')).toBe(false);
    expect(isAgentRunning('c')).toBe(false);
  });

  it('不同 instanceId 互不影响', () => {
    spawnAgent(makeOpts('x'));
    spawnAgent(makeOpts('y'));
    stopAgent('x');
    expect(isAgentRunning('x')).toBe(false);
    expect(isAgentRunning('y')).toBe(true);
  });
});
