// removeAgentAssignment：删除 agent 时应让 bot 离开所有房间 + 清理 token + 清空悬空 coordinator
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock 工厂会被提升到顶部，用 vi.hoisted 让 mock 引用与工厂共享
const mocks = vi.hoisted(() => {
  const fakeRoom = (roomId: string, members: Record<string, string>) => ({
    roomId,
    getMember: (uid: string) => (members[uid] ? { membership: members[uid] } : null),
  });
  return {
    leaveMock: vi.fn().mockResolvedValue(undefined),
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
vi.mock('../../src/main/matrix/sync-manager', () => ({
  getSyncingClient: vi.fn(() => ({ getRooms: () => mocks.rooms })),
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
    mocks.deleteSecretMock.mockClear();
    mocks.setWorkspaceCoordinatorMock.mockClear();
  });

  it('让 bot 离开它已加入的全部房间（membership=join）', async () => {
    await removeAgentAssignment('inst-1');
    expect(mocks.leaveMock).toHaveBeenCalledTimes(2);
    const leftRooms = mocks.leaveMock.mock.calls.map((c) => c[0]);
    expect(leftRooms).toEqual(expect.arrayContaining(['!team:localhost', '!other:localhost']));
    expect(leftRooms).not.toContain('!nope:localhost');
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
