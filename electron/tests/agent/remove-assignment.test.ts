// removeAgentAssignment：删除 agent 时清理 keychain override + 清空悬空 default agent
//
// v2（Task 10）：agent 无 Matrix 身份——不再离房 / 不删 bot token。
// v25：去编排——sub 删除触发父 main 重启的用例随 role/parent 概念退役删除
//（团队化语义由后续 task 按 spec §4 增补新测试）。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    getSecretMock: vi.fn(async () => 'bot-token'),
    deleteSecretMock: vi.fn(async () => undefined),
    getWorkspaceMock: vi.fn(() => ({
      defaultAgentInstanceId: 'inst-1',
      directoryPath: '/tmp',
      ownerId: '@o:l',
    })),
    setWorkspaceDefaultAgentMock: vi.fn(),
    // db.prepare().get 的返回（控制 SELECT row；v25 无 role/parent 列）
    getReturn: {
      agent_user_id: '@bot:localhost',
      workspace_id: 'ws-1',
    } as Record<string, unknown>,
    stopAgentMock: vi.fn(),
    isAgentRunningMock: vi.fn(() => false),
  };
});

vi.mock('../../src/main/storage/db', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      get: vi.fn(() => mocks.getReturn),
      run: vi.fn(),
      all: vi.fn(() => []),
    })),
  })),
  runMigrations: vi.fn(),
  closeDb: vi.fn(),
}));
vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: mocks.isAgentRunningMock,
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  startAgentRuntime: vi.fn(),
  stopAgentRuntime: async (id: string) => mocks.stopAgentMock(id),
}));
vi.mock('../../src/main/storage/keychain', () => ({
  getSecret: mocks.getSecretMock,
  deleteSecret: mocks.deleteSecretMock,
  setSecret: vi.fn(),
  setKeychainImpl: vi.fn(),
}));
vi.mock('../../src/main/workspace/crud', () => ({
  getWorkspace: mocks.getWorkspaceMock,
  setWorkspaceDefaultAgent: mocks.setWorkspaceDefaultAgentMock,
}));
vi.mock('../../src/main/agent/spawn-helpers', () => ({
  buildSpawnOpts: (input: unknown) => ({ __input: input, instanceId: (input as { instanceId: string }).instanceId }),
  resolveApiKey: vi.fn(async () => 'llm-key'),
}));
vi.mock('../../src/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { removeAgentAssignment } from '../../src/main/agent/ipc.handlers';

// 顶层 beforeEach：所有 describe 共享的 mock 重置
beforeEach(() => {
  mocks.deleteSecretMock.mockReset();
  mocks.deleteSecretMock.mockResolvedValue(undefined);
  mocks.setWorkspaceDefaultAgentMock.mockReset();
  mocks.stopAgentMock.mockReset();
  mocks.isAgentRunningMock.mockReset();
  mocks.isAgentRunningMock.mockImplementation(() => false);
  mocks.getReturn = {
    agent_user_id: '@bot:localhost',
    workspace_id: 'ws-1',
  };
});

describe('removeAgentAssignment', () => {

  it('v2（Task 10）：不做任何 Matrix 清理（无 kick / 无 leave / 不删 bot token）', async () => {
    await removeAgentAssignment('inst-1');
    expect(mocks.deleteSecretMock).not.toHaveBeenCalledWith('bot.@bot:localhost.matrix_token');
    // API key override 仍清理
    expect(mocks.deleteSecretMock).toHaveBeenCalledWith('agent.inst-1.api_key_override');
  });

  it('被删实例是默认会话 agent 时清空 defaultAgentInstanceId', async () => {
    mocks.getWorkspaceMock.mockReturnValue({ defaultAgentInstanceId: 'inst-1', directoryPath: '/tmp', ownerId: '@o:l' });
    await removeAgentAssignment('inst-1');
    expect(mocks.setWorkspaceDefaultAgentMock).toHaveBeenCalledWith('ws-1', null);
  });

  it('被删实例不是默认会话 agent 时不动 defaultAgentInstanceId', async () => {
    mocks.getWorkspaceMock.mockReturnValue({ defaultAgentInstanceId: 'other-inst', directoryPath: '/tmp', ownerId: '@o:l' });
    await removeAgentAssignment('inst-1');
    expect(mocks.setWorkspaceDefaultAgentMock).not.toHaveBeenCalled();
  });
});
