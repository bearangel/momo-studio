// room-ops dissolveRoom / getRoomMembers 单测：用 mock Matrix client + keychain
// 覆盖解散逻辑的多条路径与成员面板映射。与 room-ops.test.ts（仅测 guard）互补。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 用 vi.hoisted 提前声明可在 mock 工厂内引用的可变桩
const {
  getCurrentUserIdMock,
  getSyncingClientMock,
  getSecretMock,
  createMatrixClientMock,
  listWorkspacesMock,
  botLeaveMock,
} = vi.hoisted(() => ({
  getCurrentUserIdMock: vi.fn(() => '@owner:localhost'),
  getSyncingClientMock: vi.fn(() => null),
  getSecretMock: vi.fn(async () => null),
  createMatrixClientMock: vi.fn(),
  listWorkspacesMock: vi.fn((): unknown[] => []),
  botLeaveMock: vi.fn(async () => undefined),
}));

vi.mock('../../src/main/matrix/session', () => ({
  getOwnerMatrixClient: vi.fn(),
  getCurrentUserId: getCurrentUserIdMock,
}));
vi.mock('../../src/main/matrix/sync-manager', () => ({
  getSyncingClient: getSyncingClientMock,
}));
vi.mock('../../src/main/storage/keychain', () => ({
  getSecret: getSecretMock,
}));
vi.mock('../../src/main/matrix/client', () => ({
  createMatrixClient: createMatrixClientMock,
}));
vi.mock('../../src/main/workspace/crud', () => ({
  listWorkspaces: listWorkspacesMock,
}));
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { dissolveRoom, getRoomMembers } from '../../src/main/im/room-ops';

const ROOM_ID = '!room:localhost';
const BOT1 = '@bot1:localhost';
const BOT2 = '@bot2:localhost';

/** 构造一个 mock RoomMember（matrix-js-sdk RoomMember 最小子集） */
function makeMember(userId: string, name: string, powerLevel: number, avatarUrl: string | null) {
  return {
    userId,
    name,
    powerLevel,
    getAvatarUrl: vi.fn(() => avatarUrl),
  };
}

/** 构造一个 mock Room（getJoinedMembers / getMember / members） */
function makeRoom(members: ReturnType<typeof makeMember>[]) {
  return {
    getJoinedMembers: vi.fn(() => members),
    getMember: vi.fn((userId: string) => members.find((m) => m.userId === userId)),
  };
}

/** 构造一个 mock 同步中的 client */
function makeSyncingClient(room: ReturnType<typeof makeRoom>) {
  return {
    baseUrl: 'http://127.0.0.1:8008',
    getHomeserverUrl: vi.fn(() => 'http://127.0.0.1:8008'),
    getRoom: vi.fn(() => room),
    leave: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listWorkspacesMock.mockReturnValue([]);
  getCurrentUserIdMock.mockReturnValue('@owner:localhost');
  getSyncingClientMock.mockReturnValue(null);
  getSecretMock.mockResolvedValue(null);
  botLeaveMock.mockResolvedValue(undefined);
  // createMatrixClient 默认返回一个带 leave 的 bot client
  createMatrixClientMock.mockImplementation(() => ({ leave: botLeaveMock }));
});

describe('room-ops dissolveRoom', () => {
  it('happy-path：所有 bot token 齐全且 leave 成功 → dissolved=true', async () => {
    const room = makeRoom([
      makeMember('@owner:localhost', '我', 100, null),
      makeMember(BOT1, 'Bot1', 50, 'http://x/a.png'),
      makeMember(BOT2, 'Bot2', 0, null),
    ]);
    const client = makeSyncingClient(room);
    getSyncingClientMock.mockReturnValue(client);
    getSecretMock.mockImplementation(async (key: string) =>
      key.includes(BOT1) ? 'tok1' : key.includes(BOT2) ? 'tok2' : null,
    );

    const res = await dissolveRoom(ROOM_ID);

    expect(res.dissolved).toBe(true);
    // 两个 bot 各调用一次 leave(roomId)
    expect(botLeaveMock).toHaveBeenCalledTimes(2);
    expect(botLeaveMock).toHaveBeenCalledWith(ROOM_ID);
    // 用户最后离开
    expect(client.leave).toHaveBeenCalledTimes(1);
    expect(client.leave).toHaveBeenCalledWith(ROOM_ID);
  });

  it('bot token 丢失 → 降级为仅用户离开，dissolved=false', async () => {
    const room = makeRoom([
      makeMember('@owner:localhost', '我', 100, null),
      makeMember(BOT1, 'Bot1', 50, null), // token 缺失
    ]);
    const client = makeSyncingClient(room);
    getSyncingClientMock.mockReturnValue(client);
    getSecretMock.mockResolvedValue(null); // bot token 全丢

    const res = await dissolveRoom(ROOM_ID);

    expect(res.dissolved).toBe(false);
    // bot 未被调用 leave（因 token 缺失直接 continue）
    expect(botLeaveMock).not.toHaveBeenCalled();
    // 用户仍离开（降级不阻断退出）
    expect(client.leave).toHaveBeenCalledWith(ROOM_ID);
  });

  it('botClient.leave 抛错 → 该 bot 计为未离开，dissolved=false，用户仍离开', async () => {
    const room = makeRoom([
      makeMember('@owner:localhost', '我', 100, null),
      makeMember(BOT1, 'Bot1', 50, null),
    ]);
    const client = makeSyncingClient(room);
    getSyncingClientMock.mockReturnValue(client);
    getSecretMock.mockResolvedValue('tok1');
    botLeaveMock.mockRejectedValue(new Error('network down'));

    const res = await dissolveRoom(ROOM_ID);

    expect(res.dissolved).toBe(false);
    expect(botLeaveMock).toHaveBeenCalledWith(ROOM_ID);
    // 错误被吞没，用户仍正常离开
    expect(client.leave).toHaveBeenCalledWith(ROOM_ID);
  });

  it('房间只有用户（无 bot）→ dissolved=true，无 bot 调用', async () => {
    const room = makeRoom([makeMember('@owner:localhost', '我', 100, null)]);
    const client = makeSyncingClient(room);
    getSyncingClientMock.mockReturnValue(client);

    const res = await dissolveRoom(ROOM_ID);

    expect(res.dissolved).toBe(true);
    expect(botLeaveMock).not.toHaveBeenCalled();
    expect(client.leave).toHaveBeenCalledWith(ROOM_ID);
  });

  it('同步 client 已就绪但房间不存在 → 抛清晰错误', async () => {
    const client = {
      baseUrl: 'http://127.0.0.1:8008',
      getRoom: vi.fn(() => undefined),
      leave: vi.fn(),
    };
    getSyncingClientMock.mockReturnValue(client);

    await expect(dissolveRoom('!missing:localhost')).rejects.toThrow(/未找到房间/);
  });

  it('团队群受保护 → 抛错且不调用任何 Matrix 操作', async () => {
    listWorkspacesMock.mockReturnValue([{ teamSessionId: ROOM_ID }]);

    await expect(dissolveRoom(ROOM_ID)).rejects.toThrow(/团队群/);
    // 不应触达 client / bot leave
    expect(botLeaveMock).not.toHaveBeenCalled();
  });
});

describe('room-ops getRoomMembers', () => {
  it('happy-path：映射 displayName/powerLevel/isBot/isLocalUser/avatarUrl', async () => {
    const owner = makeMember('@owner:localhost', 'Alice', 100, 'http://x/me.png');
    const bot = makeMember(BOT1, 'BotOne', 50, 'http://x/bot.png');
    const room = makeRoom([owner, bot]);
    const client = makeSyncingClient(room);
    getSyncingClientMock.mockReturnValue(client);

    const members = await getRoomMembers(ROOM_ID);

    expect(members).toHaveLength(2);
    const me = members.find((m) => m.userId === '@owner:localhost')!;
    const b = members.find((m) => m.userId === BOT1)!;
    expect(me.isLocalUser).toBe(true);
    expect(me.isBot).toBe(false);
    expect(me.powerLevel).toBe(100);
    expect(me.displayName).toBe('Alice');
    expect(me.avatarUrl).toBe('http://x/me.png');
    expect(b.isBot).toBe(true);
    expect(b.isLocalUser).toBe(false);
    expect(b.powerLevel).toBe(50);
    // getAvatarUrl 被以 (baseUrl,64,64,'crop',false,false) 调用
    expect(owner.getAvatarUrl).toHaveBeenCalledWith(
      'http://127.0.0.1:8008', 64, 64, 'crop', false, false,
    );
  });

  it('成员 name 为空时 displayName 回退到 userId', async () => {
    const m = makeMember(BOT1, '', 0, null);
    const room = makeRoom([m]);
    const client = makeSyncingClient(room);
    getSyncingClientMock.mockReturnValue(client);

    const members = await getRoomMembers(ROOM_ID);

    expect(members[0].displayName).toBe(BOT1);
  });

  it('getAvatarUrl 返回 null 时 avatarUrl 为 null', async () => {
    const m = makeMember(BOT1, 'B', 0, null);
    const room = makeRoom([m]);
    const client = makeSyncingClient(room);
    getSyncingClientMock.mockReturnValue(client);

    const members = await getRoomMembers(ROOM_ID);

    expect(members[0].avatarUrl).toBeNull();
  });

  it('同步 client 未就绪 → 返回空数组（不抛错，避免面板白屏）', async () => {
    getSyncingClientMock.mockReturnValue(null);
    await expect(getRoomMembers(ROOM_ID)).resolves.toEqual([]);
  });

  it('房间不存在 → 返回空数组（不抛错）', async () => {
    const client = { getRoom: vi.fn(() => undefined), getHomeserverUrl: vi.fn() };
    getSyncingClientMock.mockReturnValue(client as never);
    await expect(getRoomMembers('!missing:localhost')).resolves.toEqual([]);
  });
});
