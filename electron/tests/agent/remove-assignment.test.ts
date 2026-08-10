// removeAgentAssignment：删除 agent 时应让 bot 离开所有房间 + 清理 token + 清空悬空 coordinator
//
// v1.5.8：
//   - 主路径用 owner client kick（不依赖 bot token），fallback 才用 bot 自己 leave
//   - 删 sub 时重启父 main agent 让其 subAgents 重建（否则 dispatch_to 不匹配 → sub 无响应）
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const fakeRoom = (roomId: string, members: Record<string, string>) => ({
    roomId,
    getMember: (uid: string) => (members[uid] ? { membership: members[uid] } : null),
  });
  return {
    leaveMock: vi.fn().mockResolvedValue(undefined),
    kickMock: vi.fn().mockResolvedValue(undefined),
    getSecretMock: vi.fn(async () => 'bot-token'),
    deleteSecretMock: vi.fn(async () => undefined),
    getWorkspaceMock: vi.fn(() => ({
      coordinatorInstanceId: 'inst-1',
      teamRoomId: '!team:localhost',
      directoryPath: '/tmp',
      ownerId: '@o:l',
    })),
    setWorkspaceCoordinatorMock: vi.fn(),
    rooms: [
      fakeRoom('!team:localhost', { '@bot:localhost': 'join' }),
      fakeRoom('!other:localhost', { '@bot:localhost': 'join' }),
      fakeRoom('!nope:localhost', { '@bot:localhost': 'leave' }),
    ],
    // db.prepare().all 的返回（控制 listSubAssignments / listAssignments）
    allReturn: [] as unknown[],
    // db.prepare().get 的返回（控制 SELECT row）
    getReturn: {
      bot_matrix_user_id: '@bot:localhost',
      workspace_id: 'ws-1',
      role: 'main',
      parent_instance_id: null,
    } as Record<string, unknown>,
    spawnAgentMock: vi.fn(),
    stopAgentMock: vi.fn(),
    isAgentRunningMock: vi.fn(() => false),
    resolveApiKeyMock: vi.fn(async () => 'llm-key'),
    // agent/crud mocks（用于 restartMainForSubChange 路径）
    listAssignmentsMock: vi.fn(() => []),
    listSubAssignmentsMock: vi.fn(() => []),
    getAgentDefinitionMock: vi.fn(() => null),
  };
});

vi.mock('../../src/main/storage/db', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      get: vi.fn(() => mocks.getReturn),
      run: vi.fn(),
      all: vi.fn(() => mocks.allReturn),
    })),
  })),
  runMigrations: vi.fn(),
  closeDb: vi.fn(),
}));
vi.mock('../../src/main/agent/runtime-manager', () => ({
  stopAgent: mocks.stopAgentMock,
  isAgentRunning: mocks.isAgentRunningMock,
  spawnAgent: mocks.spawnAgentMock,
}));
vi.mock('../../src/main/agent/crud', () => ({
  listAssignments: mocks.listAssignmentsMock,
  listSubAssignments: mocks.listSubAssignmentsMock,
  getAgentDefinition: mocks.getAgentDefinitionMock,
}));
vi.mock('../../src/main/matrix/client', () => ({
  createMatrixClient: vi.fn(() => ({ leave: mocks.leaveMock })),
}));
vi.mock('../../src/main/matrix/sync-manager', () => ({
  getSyncingClient: vi.fn(() => ({
    getRooms: () => mocks.rooms,
    kick: mocks.kickMock,
  })),
}));
vi.mock('../../src/main/storage/keychain', () => ({
  getSecret: mocks.getSecretMock,
  deleteSecret: mocks.deleteSecretMock,
  setSecret: vi.fn(),
  setKeychainImpl: vi.fn(),
}));
vi.mock('../../src/main/workspace/crud', () => ({
  getWorkspace: mocks.getWorkspaceMock,
  setWorkspaceCoordinator: mocks.setWorkspaceCoordinatorMock,
}));
vi.mock('../../src/main/agent/spawn-helpers', () => ({
  buildSpawnOpts: (input: unknown) => ({ __input: input, instanceId: (input as { instanceId: string }).instanceId }),
  resolveApiKey: mocks.resolveApiKeyMock,
  HOMESERVER_URL: 'http://127.0.0.1:8008',
}));
vi.mock('../../src/main/matrix/session', () => ({ getOwnerMatrixClient: vi.fn(), getCurrentUserId: vi.fn(() => '@o:localhost') }));
vi.mock('../../src/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { removeAgentAssignment } from '../../src/main/agent/ipc.handlers';

// 顶层 beforeEach：所有 describe 共享的 mock 重置
beforeEach(() => {
  mocks.leaveMock.mockReset();
  mocks.leaveMock.mockResolvedValue(undefined);
  mocks.kickMock.mockReset();
  mocks.kickMock.mockResolvedValue(undefined);
  mocks.deleteSecretMock.mockReset();
  mocks.deleteSecretMock.mockResolvedValue(undefined);
  mocks.setWorkspaceCoordinatorMock.mockReset();
  mocks.spawnAgentMock.mockReset();
  mocks.stopAgentMock.mockReset();
  mocks.isAgentRunningMock.mockReset();
  mocks.isAgentRunningMock.mockImplementation(() => false);
  mocks.listAssignmentsMock.mockReset();
  mocks.listAssignmentsMock.mockReturnValue([]);
  mocks.listSubAssignmentsMock.mockReset();
  mocks.listSubAssignmentsMock.mockReturnValue([]);
  mocks.getAgentDefinitionMock.mockReset();
  mocks.getSecretMock.mockReset();
  mocks.getSecretMock.mockResolvedValue('bot-token');
  mocks.allReturn = [];
  mocks.getReturn = {
    bot_matrix_user_id: '@bot:localhost',
    workspace_id: 'ws-1',
    role: 'main',
    parent_instance_id: null,
  };
});

describe('removeAgentAssignment', () => {

  it('v1.5.8：用 owner client kick bot 离开它已加入的全部房间（不调 bot leave）', async () => {
    await removeAgentAssignment('inst-1');
    expect(mocks.kickMock).toHaveBeenCalledTimes(2);
    const kickedRooms = mocks.kickMock.mock.calls.map((c) => c[0]);
    expect(kickedRooms).toEqual(expect.arrayContaining(['!team:localhost', '!other:localhost']));
    expect(kickedRooms).not.toContain('!nope:localhost');
    expect(mocks.leaveMock).not.toHaveBeenCalled();
  });

  it('owner kick 失败时 fallback 到 bot 自己 leave', async () => {
    mocks.kickMock.mockRejectedValue(new Error('M_FORBIDDEN: insufficient power'));
    await removeAgentAssignment('inst-1');
    expect(mocks.leaveMock).toHaveBeenCalledTimes(2);
  });

  it('owner kick 失败且 bot token 丢失 → 不调 leave', async () => {
    mocks.kickMock.mockRejectedValue(new Error('M_FORBIDDEN'));
    mocks.getSecretMock.mockResolvedValueOnce(null);
    await removeAgentAssignment('inst-1');
    expect(mocks.leaveMock).toHaveBeenCalledTimes(1);
  });

  it('删除 bot token', async () => {
    await removeAgentAssignment('inst-1');
    expect(mocks.deleteSecretMock).toHaveBeenCalledWith('bot.@bot:localhost.matrix_token');
  });

  it('被删实例是协调 agent 时清空 coordinatorInstanceId', async () => {
    mocks.getWorkspaceMock.mockReturnValue({ coordinatorInstanceId: 'inst-1', teamRoomId: '!team:localhost', directoryPath: '/tmp', ownerId: '@o:l' });
    await removeAgentAssignment('inst-1');
    expect(mocks.setWorkspaceCoordinatorMock).toHaveBeenCalledWith('ws-1', null);
  });

  it('被删实例不是协调 agent 时不动 coordinatorInstanceId', async () => {
    mocks.getWorkspaceMock.mockReturnValue({ coordinatorInstanceId: 'other-inst', teamRoomId: '!team:localhost', directoryPath: '/tmp', ownerId: '@o:l' });
    await removeAgentAssignment('inst-1');
    expect(mocks.setWorkspaceCoordinatorMock).not.toHaveBeenCalled();
  });
});

describe('removeAgentAssignment: v1.5.8 sub 删除触发 main 重启', () => {
  beforeEach(() => {
    mocks.getReturn = {
      bot_matrix_user_id: '@sub-bot:localhost',
      workspace_id: 'ws-1',
      role: 'sub',
      parent_instance_id: 'main-inst-1',
    };
  });

  it('删 sub 且父 main 在运行 → 重启 main（重建 subAgents）', async () => {
    mocks.isAgentRunningMock.mockImplementation((id: string) => id === 'main-inst-1');
    mocks.listAssignmentsMock.mockReturnValue([{
      instanceId: 'main-inst-1',
      agentDefinitionId: 'def-main',
      botMatrixUserId: '@main-bot:localhost',
      workspaceId: 'ws-1',
      role: 'main',
    }]);
    mocks.getAgentDefinitionMock.mockReturnValue({
      id: 'def-main', name: 'PM', slug: 'pm', modelProviderId: 'prov-1', modelName: 'gpt-4o',
    });

    await removeAgentAssignment('sub-inst-1');

    expect(mocks.stopAgentMock).toHaveBeenCalledWith('main-inst-1');
    expect(mocks.spawnAgentMock).toHaveBeenCalledTimes(1);
  });

  it('删 sub 但父 main 未运行 → 不重启', async () => {
    mocks.isAgentRunningMock.mockImplementation(() => false);

    await removeAgentAssignment('sub-inst-1');

    expect(mocks.stopAgentMock).not.toHaveBeenCalledWith('main-inst-1');
    expect(mocks.spawnAgentMock).not.toHaveBeenCalled();
  });

  it('删 main 不触发 main 重启（即使级联删 subs，subs 的 parent 已停）', async () => {
    mocks.getReturn = {
      bot_matrix_user_id: '@main-bot:localhost',
      workspace_id: 'ws-1',
      role: 'main',
      parent_instance_id: null,
    };
    mocks.listSubAssignmentsMock.mockReturnValue([]);

    await removeAgentAssignment('main-inst-1');

    expect(mocks.stopAgentMock).toHaveBeenCalledTimes(1);
    expect(mocks.stopAgentMock).toHaveBeenCalledWith('main-inst-1');
    expect(mocks.spawnAgentMock).not.toHaveBeenCalled();
  });
});
