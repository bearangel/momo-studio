// removeAgentAssignment：删除 agent 时应让 bot 离开所有房间 + 清理 token + 清空悬空 coordinator
//
// v1.5.8：主路径用 owner client kick（不依赖 bot token），fallback 才用 bot 自己 leave
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
    getWorkspaceMock: vi.fn(() => ({ coordinatorInstanceId: 'inst-1', teamRoomId: '!team:localhost' })),
    setWorkspaceCoordinatorMock: vi.fn(),
    rooms: [
      fakeRoom('!team:localhost', { '@bot:localhost': 'join' }),
      fakeRoom('!other:localhost', { '@bot:localhost': 'join' }),
      fakeRoom('!nope:localhost', { '@bot:localhost': 'leave' }),
    ],
  };
});

vi.mock('../../src/main/storage/db', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ bot_matrix_user_id: '@bot:localhost', workspace_id: 'ws-1' })),
      run: vi.fn(),
    })),
  })),
  runMigrations: vi.fn(),
  closeDb: vi.fn(),
}));
vi.mock('../../src/main/agent/runtime-manager', () => ({
  stopAgent: vi.fn(),
  isAgentRunning: vi.fn(() => false),
  spawnAgent: vi.fn(),
}));
vi.mock('../../src/main/matrix/client', () => ({
  createMatrixClient: vi.fn(() => ({ leave: mocks.leaveMock })),
}));
// v1.5.8：syncingClient 同时提供 kick（主路径）+ getRooms
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
vi.mock('../../src/main/matrix/session', () => ({ getOwnerMatrixClient: vi.fn(), getCurrentUserId: vi.fn(() => '@o:localhost') }));
vi.mock('../../src/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { removeAgentAssignment } from '../../src/main/agent/ipc.handlers';

describe('removeAgentAssignment', () => {
  beforeEach(() => {
    mocks.leaveMock.mockClear();
    mocks.kickMock.mockClear();
    mocks.kickMock.mockResolvedValue(undefined);
    mocks.deleteSecretMock.mockClear();
    mocks.setWorkspaceCoordinatorMock.mockClear();
  });

  it('v1.5.8：用 owner client kick bot 离开它已加入的全部房间（不调 bot leave）', async () => {
    await removeAgentAssignment('inst-1');
    expect(mocks.kickMock).toHaveBeenCalledTimes(2);
    const kickedRooms = mocks.kickMock.mock.calls.map((c) => c[0]);
    expect(kickedRooms).toEqual(expect.arrayContaining(['!team:localhost', '!other:localhost']));
    expect(kickedRooms).not.toContain('!nope:localhost');
    // owner kick 成功 → 不 fallback 到 bot leave
    expect(mocks.leaveMock).not.toHaveBeenCalled();
  });

  it('owner kick 失败时 fallback 到 bot 自己 leave', async () => {
    mocks.kickMock.mockRejectedValue(new Error('M_FORBIDDEN: insufficient power'));
    await removeAgentAssignment('inst-1');
    // 2 个 join 房间都 fallback
    expect(mocks.leaveMock).toHaveBeenCalledTimes(2);
    const leftRooms = mocks.leaveMock.mock.calls.map((c) => c[0]);
    expect(leftRooms).toEqual(expect.arrayContaining(['!team:localhost', '!other:localhost']));
  });

  it('owner kick 失败且 bot token 丢失 → 不调 leave，仅 warn', async () => {
    mocks.kickMock.mockRejectedValue(new Error('M_FORBIDDEN'));
    mocks.getSecretMock.mockResolvedValueOnce(null);
    await removeAgentAssignment('inst-1');
    // 第一个房间 token=null → 跳过 leave；第二个房间 token=bot-token → 调 leave
    expect(mocks.leaveMock).toHaveBeenCalledTimes(1);
  });

  it('删除 bot token', async () => {
    await removeAgentAssignment('inst-1');
    expect(mocks.deleteSecretMock).toHaveBeenCalledWith('bot.@bot:localhost.matrix_token');
  });

  it('被删实例是协调 agent 时清空 coordinatorInstanceId', async () => {
    mocks.getWorkspaceMock.mockReturnValue({ coordinatorInstanceId: 'inst-1', teamRoomId: '!team:localhost' });
    await removeAgentAssignment('inst-1');
    expect(mocks.setWorkspaceCoordinatorMock).toHaveBeenCalledWith('ws-1', null);
  });

  it('被删实例不是协调 agent 时不动 coordinatorInstanceId', async () => {
    mocks.getWorkspaceMock.mockReturnValue({ coordinatorInstanceId: 'other-inst', teamRoomId: '!team:localhost' });
    await removeAgentAssignment('inst-1');
    expect(mocks.setWorkspaceCoordinatorMock).not.toHaveBeenCalled();
  });
});
