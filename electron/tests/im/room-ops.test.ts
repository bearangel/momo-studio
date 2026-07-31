// room-ops 单测：mock Matrix client + keychain，验证解散逻辑与团队群保护
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock session/client/crud/keychain/sync-manager 五层依赖
vi.mock('../../src/main/matrix/session', () => ({
  getOwnerMatrixClient: vi.fn(),
  getCurrentUserId: vi.fn(() => '@owner:localhost'),
}));
vi.mock('../../src/main/workspace/crud', () => ({
  listWorkspaces: vi.fn(() => []),
}));
vi.mock('../../src/main/storage/keychain', () => ({
  getSecret: vi.fn(async () => null),
}));
vi.mock('../../src/main/matrix/client', () => ({
  createMatrixClient: vi.fn(),
}));
// sync-manager 默认返回 null（模拟 /sync 未启动），dissolveRoom 应据此抛清晰错误
vi.mock('../../src/main/matrix/sync-manager', () => ({
  getSyncingClient: vi.fn(() => null),
}));

import { isProtectedRoom, dissolveRoom } from '../../src/main/im/room-ops';
import { listWorkspaces } from '../../src/main/workspace/crud';
import { getSyncingClient } from '../../src/main/matrix/sync-manager';

describe('room-ops isProtectedRoom', () => {
  beforeEach(() => { vi.mocked(listWorkspaces).mockReturnValue([]); });

  it('非任何 workspace 团队群的房间不受保护', () => {
    expect(isProtectedRoom('!random:localhost')).toBe(false);
  });

  it('匹配某 workspace team_room_id 的房间受保护', () => {
    vi.mocked(listWorkspaces).mockReturnValue([
      { id: 'w1', teamRoomId: '!team:localhost' } as never,
    ]);
    expect(isProtectedRoom('!team:localhost')).toBe(true);
  });
});

describe('room-ops dissolveRoom null-syncing-client guard', () => {
  it('同步 client 未就绪时抛出清晰错误（不抛模糊 TypeError）', async () => {
    vi.mocked(getSyncingClient).mockReturnValue(null);
    await expect(dissolveRoom('!room:localhost')).rejects.toThrow(/IM 尚未同步/);
  });
});
