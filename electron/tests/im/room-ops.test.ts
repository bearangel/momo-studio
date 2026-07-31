// room-ops 单测：mock Matrix client + keychain，验证解散逻辑与团队群保护
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock session/client/crud/keychain 三层依赖
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

import { isProtectedRoom } from '../../src/main/im/room-ops';
import { listWorkspaces } from '../../src/main/workspace/crud';

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
