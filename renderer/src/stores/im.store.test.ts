// renderer/src/stores/im.store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useImStore } from './im.store';
import { useStreamStore } from './stream.store';
import type { ImMessage, ImRoomInfo } from '../ipc/types';

const MOCK_ROOMS_A: ImRoomInfo[] = [
  { roomId: '!a1:localhost', name: 'A 房间 1' },
  { roomId: '!a2:localhost', name: 'A 房间 2' },
];
const MOCK_ROOMS_B: ImRoomInfo[] = [
  { roomId: '!b1:localhost', name: 'B 房间 1' },
];

const mockApi = {
  im: {
    startSync: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    getRooms: vi.fn(),
    getMessages: vi.fn().mockResolvedValue([]),
    onMessage: vi.fn().mockReturnValue(() => {}),
  },
};

beforeEach(() => {
  Object.assign(globalThis, { window: { api: mockApi } });
  useImStore.getState().reset();
  mockApi.im.getRooms.mockReset();
  mockApi.im.getRooms.mockResolvedValue(MOCK_ROOMS_A);
  mockApi.im.getMessages.mockResolvedValue([]);
  mockApi.im.send.mockClear();
});

describe('im.store', () => {
  it('loadRooms populates rooms and activates the first room', async () => {
    await useImStore.getState().loadRooms();
    expect(useImStore.getState().rooms).toHaveLength(2);
    expect(useImStore.getState().activeRoomId).toBe('!a1:localhost');
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
        roomId: '!a1:localhost',
        sender: '@a:localhost',
        body: 'hi',
        eventType: 'm.room.message',
        content: {},
        timestamp: 1,
      },
    ];
    mockApi.im.getMessages.mockResolvedValue(messages);

    await useImStore.getState().selectRoom('!a1:localhost');
    expect(useImStore.getState().messagesByRoom.get('!a1:localhost')).toEqual(messages);
  });

  it('receiveMessage appends to the room message list', () => {
    const msg: ImMessage = {
      eventId: 'e2',
      roomId: '!a1:localhost',
      sender: '@b:localhost',
      body: 'hello',
      eventType: 'm.room.message',
      content: {},
      timestamp: 2,
    };
    useImStore.getState().receiveMessage(msg);
    expect(useImStore.getState().messagesByRoom.get('!a1:localhost')).toContainEqual(msg);
  });

  it('receiveMessage deduplicates by eventId', () => {
    const msg: ImMessage = {
      eventId: 'e3',
      roomId: '!a1:localhost',
      sender: '@b:localhost',
      body: 'dup',
      eventType: 'm.room.message',
      content: {},
      timestamp: 3,
    };
    useImStore.getState().receiveMessage(msg);
    useImStore.getState().receiveMessage(msg);
    expect(useImStore.getState().messagesByRoom.get('!a1:localhost')).toHaveLength(1);
  });

  it('sendMessage calls ipc.im.send with the active room id', async () => {
    await useImStore.getState().loadRooms();
    await useImStore.getState().sendMessage('hello');
    expect(mockApi.im.send).toHaveBeenCalledWith('!a1:localhost', 'hello');
  });

  it('sendMessage 不插入本地乐观消息（SDK local echo 经 sync-manager 推送，避免重复与错误归属）', async () => {
    await useImStore.getState().loadRooms();
    await useImStore.getState().sendMessage('hello');
    const msgs = useImStore.getState().messagesByRoom.get('!a1:localhost') ?? [];
    expect(msgs.some((m) => m.sender === '' || m.eventId.startsWith('local-'))).toBe(false);
  });

  it('sendMessage is a no-op when no room is active', async () => {
    await useImStore.getState().sendMessage('hello');
    expect(mockApi.im.send).not.toHaveBeenCalled();
  });
});

describe('im.store — workspace 隔离', () => {
  it('loadRooms(workspaceId) 把 workspaceId 透传给 IPC', async () => {
    await useImStore.getState().loadRooms('ws-a');
    expect(mockApi.im.getRooms).toHaveBeenCalledWith('ws-a');
  });

  it('切换 workspace 时清空旧 workspace 的房间、消息、激活房间', async () => {
    // 先在 workspace A 建立状态
    mockApi.im.getRooms.mockResolvedValue(MOCK_ROOMS_A);
    await useImStore.getState().loadRooms('ws-a');
    await useImStore.getState().selectRoom('!a1:localhost');
    expect(useImStore.getState().rooms).toHaveLength(2);
    expect(useImStore.getState().activeRoomId).toBe('!a1:localhost');
    expect(useImStore.getState().messagesByRoom.size).toBeGreaterThan(0);
    expect(useImStore.getState().currentWorkspaceId).toBe('ws-a');

    // 切换到 workspace B：旧 workspace 的房间和消息应清空
    mockApi.im.getRooms.mockResolvedValue(MOCK_ROOMS_B);
    await useImStore.getState().loadRooms('ws-b');
    expect(useImStore.getState().rooms).toEqual(MOCK_ROOMS_B);
    expect(useImStore.getState().activeRoomId).toBe('!b1:localhost');
    // 旧 workspace 房间的消息缓存应已清除
    expect(useImStore.getState().messagesByRoom.has('!a1:localhost')).toBe(false);
    expect(useImStore.getState().messagesByRoom.has('!a2:localhost')).toBe(false);
    expect(useImStore.getState().currentWorkspaceId).toBe('ws-b');
  });

  it('同一 workspace 重复 loadRooms 不重置状态（保留当前选中房间）', async () => {
    mockApi.im.getRooms.mockResolvedValue(MOCK_ROOMS_A);
    await useImStore.getState().loadRooms('ws-a');
    await useImStore.getState().selectRoom('!a2:localhost');
    expect(useImStore.getState().activeRoomId).toBe('!a2:localhost');

    // 同 workspace 再 load：activeRoomId 保持选中（不退回首条）
    await useImStore.getState().loadRooms('ws-a');
    expect(useImStore.getState().activeRoomId).toBe('!a2:localhost');
  });
});

describe('im.store — 流式→持久化替换', () => {
  beforeEach(() => {
    useStreamStore.setState({ streams: new Map() });
  });

  it('收到带 stream_session_id 的消息时清理对应临时流式状态', () => {
    // 预置一个活跃流式会话
    useStreamStore.setState({
      streams: new Map([
        [
          'sess-1',
          {
            streamSessionId: 'sess-1',
            roomId: '!a1:localhost',
            botUserId: '@bot:local',
            thinking: '',
            text: '流式中...',
            toolCalls: [],
            status: 'streaming' as const,
            dispatchChildren: [],
          },
        ],
      ]),
    });
    expect(useStreamStore.getState().streams.has('sess-1')).toBe(true);

    // 推送 agent 最终消息（带 stream_session_id）
    const finalMsg: ImMessage = {
      eventId: 'e-final',
      roomId: '!a1:localhost',
      sender: '@bot:local',
      body: '最终回复',
      eventType: 'm.room.message',
      content: { 'io.momo-studio.stream_session_id': 'sess-1' },
      timestamp: 10,
    };
    useImStore.getState().receiveMessage(finalMsg);

    // 临时流式状态应已被清理
    expect(useStreamStore.getState().streams.has('sess-1')).toBe(false);
    // 消息应已写入列表
    expect(useImStore.getState().messagesByRoom.get('!a1:localhost')).toContainEqual(finalMsg);
  });

  it('重复回放的消息不重复触发 clearCompleted', () => {
    useStreamStore.setState({
      streams: new Map([
        [
          'sess-2',
          {
            streamSessionId: 'sess-2',
            roomId: '!a1:localhost',
            botUserId: '@bot:local',
            thinking: '',
            text: '',
            toolCalls: [],
            status: 'streaming' as const,
            dispatchChildren: [],
          },
        ],
      ]),
    });

    const finalMsg: ImMessage = {
      eventId: 'e-dup',
      roomId: '!a1:localhost',
      sender: '@bot:local',
      body: '回复',
      eventType: 'm.room.message',
      content: { 'io.momo-studio.stream_session_id': 'sess-2' },
      timestamp: 11,
    };

    // 第一次推送：清理 sess-2
    useImStore.getState().receiveMessage(finalMsg);
    expect(useStreamStore.getState().streams.has('sess-2')).toBe(false);

    // 重新预置 sess-2（模拟 race：end chunk 在 Matrix 消息之后到达重建态）
    useStreamStore.setState({
      streams: new Map([
        [
          'sess-2',
          {
            streamSessionId: 'sess-2',
            roomId: '!a1:localhost',
            botUserId: '@bot:local',
            thinking: '',
            text: '',
            toolCalls: [],
            status: 'streaming' as const,
            dispatchChildren: [],
          },
        ],
      ]),
    });

    // 第二次推送相同 eventId：去重，不触发 clearCompleted
    useImStore.getState().receiveMessage(finalMsg);
    expect(useStreamStore.getState().streams.has('sess-2')).toBe(true);
  });

  it('不含 stream_session_id 的消息不影响流式状态', () => {
    useStreamStore.setState({
      streams: new Map([
        [
          'sess-3',
          {
            streamSessionId: 'sess-3',
            roomId: '!a1:localhost',
            botUserId: '@bot:local',
            thinking: '',
            text: '',
            toolCalls: [],
            status: 'streaming' as const,
            dispatchChildren: [],
          },
        ],
      ]),
    });

    const normalMsg: ImMessage = {
      eventId: 'e-normal',
      roomId: '!a1:localhost',
      sender: '@user:local',
      body: '普通消息',
      eventType: 'm.room.message',
      content: {},
      timestamp: 12,
    };
    useImStore.getState().receiveMessage(normalMsg);

    expect(useStreamStore.getState().streams.has('sess-3')).toBe(true);
  });
});
