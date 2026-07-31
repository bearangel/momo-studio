// renderer/src/stores/im.store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useImStore } from './im.store';
import type { ImMessage, ImRoomInfo } from '../ipc/types';

const MOCK_ROOMS: ImRoomInfo[] = [
  { roomId: '!room1:localhost', name: 'Room 1' },
  { roomId: '!room2:localhost', name: 'Room 2' },
];

const mockApi = {
  im: {
    startSync: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    getRooms: vi.fn().mockResolvedValue(MOCK_ROOMS),
    getMessages: vi.fn().mockResolvedValue([]),
    onMessage: vi.fn().mockReturnValue(() => {}),
  },
};

beforeEach(() => {
  Object.assign(globalThis, { window: { api: mockApi } });
  useImStore.getState().reset();
  mockApi.im.getRooms.mockResolvedValue(MOCK_ROOMS);
  mockApi.im.getMessages.mockResolvedValue([]);
  mockApi.im.send.mockClear();
});

describe('im.store', () => {
  it('loadRooms populates rooms and activates the first room', async () => {
    await useImStore.getState().loadRooms();
    expect(useImStore.getState().rooms).toHaveLength(2);
    expect(useImStore.getState().activeRoomId).toBe('!room1:localhost');
  });

  it('loadRooms with empty rooms leaves activeRoomId null', async () => {
    mockApi.im.getRooms.mockResolvedValue([]);
    await useImStore.getState().loadRooms();
    expect(useImStore.getState().rooms).toHaveLength(0);
    expect(useImStore.getState().activeRoomId).toBeNull();
  });

  it('selectRoom loads messages for the room', async () => {
    const messages: ImMessage[] = [
      {
        eventId: 'e1',
        roomId: '!room1:localhost',
        sender: '@a:localhost',
        body: 'hi',
        eventType: 'm.room.message',
        content: {},
        timestamp: 1,
      },
    ];
    mockApi.im.getMessages.mockResolvedValue(messages);

    await useImStore.getState().selectRoom('!room1:localhost');
    expect(useImStore.getState().messagesByRoom.get('!room1:localhost')).toEqual(messages);
  });

  it('receiveMessage appends to the room message list', () => {
    const msg: ImMessage = {
      eventId: 'e2',
      roomId: '!room1:localhost',
      sender: '@b:localhost',
      body: 'hello',
      eventType: 'm.room.message',
      content: {},
      timestamp: 2,
    };
    useImStore.getState().receiveMessage(msg);
    expect(useImStore.getState().messagesByRoom.get('!room1:localhost')).toContainEqual(msg);
  });

  it('receiveMessage deduplicates by eventId', () => {
    const msg: ImMessage = {
      eventId: 'e3',
      roomId: '!room1:localhost',
      sender: '@b:localhost',
      body: 'dup',
      eventType: 'm.room.message',
      content: {},
      timestamp: 3,
    };
    useImStore.getState().receiveMessage(msg);
    useImStore.getState().receiveMessage(msg);
    expect(useImStore.getState().messagesByRoom.get('!room1:localhost')).toHaveLength(1);
  });

  it('sendMessage calls ipc.im.send with the active room id', async () => {
    await useImStore.getState().loadRooms();
    await useImStore.getState().sendMessage('hello');
    expect(mockApi.im.send).toHaveBeenCalledWith('!room1:localhost', 'hello');
  });

  it('sendMessage 不插入本地乐观消息（SDK local echo 经 sync-manager 推送，避免重复与错误归属）', async () => {
    await useImStore.getState().loadRooms();
    await useImStore.getState().sendMessage('hello');
    const msgs = useImStore.getState().messagesByRoom.get('!room1:localhost') ?? [];
    expect(msgs.some((m) => m.sender === '' || m.eventId.startsWith('local-'))).toBe(false);
  });

  it('sendMessage is a no-op when no room is active', async () => {
    await useImStore.getState().sendMessage('hello');
    expect(mockApi.im.send).not.toHaveBeenCalled();
  });
});
