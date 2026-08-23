// renderer/src/stores/im.store.test.ts
//
// v2.0 A 子系统：测试已对齐新的 IPC 契约：
//   - getMessages 返回 { messages, eventsByMessage }
//   - loadOlderMessages 接受 (roomId, beforeTs, count) 返回 { messages, eventsByMessage, hasMore }
//   - ImMessage 字段对齐 SQLite messages 表 row（id 替代 eventId，createdAt 替代 timestamp，删除 content）
//   - 新增 onIncomingEventBatch action（im:message_event_batch 触发）
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useImStore } from './im.store';
import { useStreamStore } from './stream.store';
import type { ImMessage, ImRoomInfo, MessageEventRow } from '../ipc/types';

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
    getMessages: vi.fn(),
    loadOlderMessages: vi.fn(),
    getMessageEvents: vi.fn().mockResolvedValue([]),
    onMessage: vi.fn().mockReturnValue(() => {}),
    onMessageEventBatch: vi.fn().mockReturnValue(() => {}),
  },
};

/** 构造一条 ImMessage（默认 m.room.message，createdAt 单调递增由调用方指定） */
function mk(id: string, body: string, createdAt = 0): ImMessage {
  return {
    id,
    sessionId: '!r:localhost',
    sender: '@u:localhost',
    body,
    eventType: 'm.room.message',
    streamSessionId: null,
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'done',
    source: 'local',
    workspaceId: null,
    taskId: null,
    createdAt,
    updatedAt: createdAt,
  };
}

/** 构造 MessageEventRow（默认 text_delta） */
function mkEvent(id: string, messageId: string, seq: number): MessageEventRow {
  return {
    id,
    messageId,
    seq,
    eventType: 'text_delta',
    payload: { delta: 'x' },
    createdAt: 0,
  };
}

beforeEach(() => {
  Object.assign(globalThis, { window: { api: mockApi } });
  useImStore.getState().reset();
  mockApi.im.getRooms.mockReset();
  mockApi.im.getRooms.mockResolvedValue(MOCK_ROOMS_A);
  mockApi.im.getMessages.mockReset();
  mockApi.im.getMessages.mockResolvedValue({ messages: [], eventsByMessage: {} });
  mockApi.im.send.mockClear();
  mockApi.im.loadOlderMessages.mockReset();
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

  it('selectRoom loads messages + events for the room', async () => {
    const messages: ImMessage[] = [mk('m1', 'hi', 1)];
    const eventsByMessage: Record<string, MessageEventRow[]> = {
      m1: [mkEvent('e1', 'm1', 0)],
    };
    mockApi.im.getMessages.mockResolvedValue({ messages, eventsByMessage });

    await useImStore.getState().selectRoom('!a1:localhost');
    expect(useImStore.getState().messagesByRoom.get('!a1:localhost')).toEqual(messages);
    expect(useImStore.getState().eventsByMessage.get('m1')).toEqual(eventsByMessage.m1);
  });

  it('receiveMessage appends to the room message list', () => {
    const msg = mk('m2', 'hello', 2);
    useImStore.getState().receiveMessage(msg);
    expect(useImStore.getState().messagesByRoom.get('!r:localhost')).toContainEqual(msg);
  });

  it('receiveMessage deduplicates by SQLite messages.id', () => {
    const msg = mk('m3', 'dup', 3);
    useImStore.getState().receiveMessage(msg);
    useImStore.getState().receiveMessage(msg);
    expect(useImStore.getState().messagesByRoom.get('!r:localhost')).toHaveLength(1);
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
    expect(msgs.some((m) => m.sender === '' || m.id.startsWith('local-'))).toBe(false);
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

describe('im.store — onIncomingEventBatch（A 子系统新增）', () => {
  it('空 batch 是 no-op', () => {
    const before = useImStore.getState().eventsByMessage.size;
    useImStore.getState().onIncomingEventBatch([]);
    expect(useImStore.getState().eventsByMessage.size).toBe(before);
  });

  it('批量 events 按 messageId 累积到 eventsByMessage', () => {
    useImStore.getState().onIncomingEventBatch([
      mkEvent('e1', 'm1', 0),
      mkEvent('e2', 'm1', 1),
      mkEvent('e3', 'm2', 0),
    ]);
    expect(useImStore.getState().eventsByMessage.get('m1')).toHaveLength(2);
    expect(useImStore.getState().eventsByMessage.get('m2')).toHaveLength(1);
  });

  it('同 event id 不重复（flush 边界回放保护）', () => {
    useImStore.getState().onIncomingEventBatch([mkEvent('e1', 'm1', 0)]);
    useImStore.getState().onIncomingEventBatch([mkEvent('e1', 'm1', 0)]); // 同 id
    expect(useImStore.getState().eventsByMessage.get('m1')).toHaveLength(1);
  });
});

describe('im.store loadOlder', () => {
  it('前置拼接新拉到的更早消息', async () => {
    // 当前已有消息 m1(50), m2(60)
    const existing = [mk('m1', 'newest', 50), mk('m2', 'older', 60)];
    mockApi.im.getMessages.mockResolvedValueOnce({ messages: existing, eventsByMessage: {} });
    await useImStore.getState().selectRoom('!r:localhost');

    // 翻页：返回更早的消息 m3(10), m4(20)
    const olderBatch = [mk('m3', 'oldest1', 10), mk('m4', 'oldest2', 20)];
    mockApi.im.loadOlderMessages.mockResolvedValueOnce({
      messages: olderBatch,
      eventsByMessage: {},
      hasMore: true,
    });

    await useImStore.getState().loadOlder('!r:localhost');

    const messages = useImStore.getState().messagesByRoom.get('!r:localhost')!;
    expect(messages.map((m) => m.id)).toEqual(['m3', 'm4', 'm1', 'm2']);
    // beforeTs 应是当前最小 createdAt = 50
    expect(mockApi.im.loadOlderMessages).toHaveBeenCalledWith('!r:localhost', 50, 30);
  });

  it('hasMore=false 时短路不发 IPC', async () => {
    mockApi.im.getMessages.mockResolvedValueOnce({
      messages: [mk('m1', 'a', 10)],
      eventsByMessage: {},
    });
    await useImStore.getState().selectRoom('!r:localhost');
    mockApi.im.loadOlderMessages.mockResolvedValueOnce({
      messages: [],
      eventsByMessage: {},
      hasMore: false,
    });
    await useImStore.getState().loadOlder('!r:localhost');

    mockApi.im.loadOlderMessages.mockClear();
    await useImStore.getState().loadOlder('!r:localhost');
    expect(mockApi.im.loadOlderMessages).not.toHaveBeenCalled();
  });

  it('加载中再次触发会被防抖（不重复 IPC）', async () => {
    mockApi.im.getMessages.mockResolvedValueOnce({
      messages: [mk('m1', 'a', 10)],
      eventsByMessage: {},
    });
    await useImStore.getState().selectRoom('!r:localhost');

    let resolveLoad!: (v: { messages: ImMessage[]; eventsByMessage: Record<string, MessageEventRow[]>; hasMore: boolean }) => void;
    const pending = new Promise<{
      messages: ImMessage[];
      eventsByMessage: Record<string, MessageEventRow[]>;
      hasMore: boolean;
    }>((r) => {
      resolveLoad = r;
    });
    mockApi.im.loadOlderMessages.mockImplementationOnce(() => pending);

    // 启动第一次 loadOlder（不 await，让它停在 ipc 调用）
    const p1 = useImStore.getState().loadOlder('!r:localhost');
    // 此时 loadingOlder=true，第二次应被 store 防抖 return（不调 IPC）
    await useImStore.getState().loadOlder('!r:localhost');

    expect(mockApi.im.loadOlderMessages).toHaveBeenCalledTimes(1);

    // resolve 让第一次完成，避免悬挂 promise
    resolveLoad({ messages: [], eventsByMessage: {}, hasMore: true });
    await p1;
  });

  it('按 SQLite messages.id 去重（服务端边界重复）', async () => {
    const existing = [mk('m1', 'a', 10), mk('m2', 'b', 20)];
    mockApi.im.getMessages.mockResolvedValueOnce({ messages: existing, eventsByMessage: {} });
    await useImStore.getState().selectRoom('!r:localhost');

    // 服务端在边界重复推送 m1 + 新的 m0
    const olderBatch = [mk('m1', 'a-dup', 10), mk('m0', 'oldest', 5)];
    mockApi.im.loadOlderMessages.mockResolvedValueOnce({
      messages: olderBatch,
      eventsByMessage: {},
      hasMore: true,
    });

    await useImStore.getState().loadOlder('!r:localhost');

    const messages = useImStore.getState().messagesByRoom.get('!r:localhost')!;
    expect(messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2']);
  });

  it('loadOlder 同时把新拉消息的 events 合并进 eventsByMessage', async () => {
    mockApi.im.getMessages.mockResolvedValueOnce({
      messages: [mk('m1', 'a', 10)],
      eventsByMessage: {},
    });
    await useImStore.getState().selectRoom('!r:localhost');

    const olderEvents: Record<string, MessageEventRow[]> = {
      m0: [mkEvent('e-old', 'm0', 0)],
    };
    mockApi.im.loadOlderMessages.mockResolvedValueOnce({
      messages: [mk('m0', 'old', 5)],
      eventsByMessage: olderEvents,
      hasMore: false,
    });
    await useImStore.getState().loadOlder('!r:localhost');

    expect(useImStore.getState().eventsByMessage.get('m0')).toEqual(olderEvents.m0);
  });

  it('selectRoom 切回已访问房间时保留分页累积（不重新拉取覆盖）', async () => {
    mockApi.im.getMessages.mockResolvedValueOnce({
      messages: [mk('m1', 'a', 10)],
      eventsByMessage: {},
    });
    await useImStore.getState().selectRoom('!r:localhost');
    mockApi.im.loadOlderMessages.mockResolvedValueOnce({
      messages: [mk('m0', 'old', 5)],
      eventsByMessage: {},
      hasMore: false,
    });
    await useImStore.getState().loadOlder('!r:localhost');
    expect(useImStore.getState().messagesByRoom.get('!r:localhost')!.length).toBe(2);

    // 切到别的房间
    mockApi.im.getMessages.mockResolvedValueOnce({
      messages: [mk('x1', 'x', 100)],
      eventsByMessage: {},
    });
    await useImStore.getState().selectRoom('!other:localhost');

    // 切回——getMessages 不应被再次调用（保留累积）
    mockApi.im.getMessages.mockClear();
    await useImStore.getState().selectRoom('!r:localhost');
    expect(mockApi.im.getMessages).not.toHaveBeenCalled();
    // 消息仍是 2 条（m0 + m1），未被覆盖
    expect(useImStore.getState().messagesByRoom.get('!r:localhost')!.length).toBe(2);
    // hasMore 仍为 false
    expect(useImStore.getState().hasMoreByRoom.get('!r:localhost')).toBe(false);
  });
});

describe('im.store — 重启场景：hydrateFromEvents 接线（A8 fix）', () => {
  beforeEach(() => {
    useStreamStore.setState({ streams: new Map() });
  });

  it('selectRoom 后把 eventsByMessage 喂给 stream.store.hydrateFromEvents（重建 StreamState）', async () => {
    // IPC 返回带 final 事件的 eventsByMessage——模拟重启后从 SQLite 拉的完整 events
    const messages: ImMessage[] = [mk('m1', 'hi', 1), mk('m2', 'done', 2)];
    const eventsByMessage: Record<string, MessageEventRow[]> = {
      m1: [mkEvent('e1', 'm1', 0), mkEvent('e2', 'm1', 1)],
      m2: [
        mkEvent('e3', 'm2', 0),
        { ...mkEvent('e4', 'm2', 1), eventType: 'final', payload: {} },
      ],
    };
    mockApi.im.getMessages.mockResolvedValue({ messages, eventsByMessage });

    await useImStore.getState().selectRoom('!a1:localhost');

    // 两个 messageId 都应已重建 StreamState
    const s1 = useStreamStore.getState().streams.get('m1');
    expect(s1).toBeDefined();
    expect(s1!.messageId).toBe('m1');
    const s2 = useStreamStore.getState().streams.get('m2');
    expect(s2).toBeDefined();
    expect(s2!.messageId).toBe('m2');
    // m2 含 final 事件，status=done
    expect(s2!.status).toBe('done');
  });

  it('selectRoom 时 eventsByMessage 为空数组也应安全处理（无流式历史消息不抛错）', async () => {
    const messages: ImMessage[] = [mk('m1', 'plain', 1)];
    mockApi.im.getMessages.mockResolvedValue({ messages, eventsByMessage: {} });

    await expect(useImStore.getState().selectRoom('!a1:localhost')).resolves.not.toThrow();
  });

  it('loadOlder 后老消息的 events 也灌入 stream.store（翻页场景）', async () => {
    // 先 selectRoom 初始化房间
    mockApi.im.getMessages.mockResolvedValueOnce({
      messages: [mk('m1', 'a', 10)],
      eventsByMessage: {},
    });
    await useImStore.getState().selectRoom('!r:localhost');
    expect(useStreamStore.getState().streams.size).toBe(0);

    // 翻页：返回 m0 + events（含 final → status=done）
    const olderEvents: Record<string, MessageEventRow[]> = {
      m0: [
        mkEvent('e-old-1', 'm0', 0),
        { ...mkEvent('e-old-2', 'm0', 1), eventType: 'final', payload: {} },
      ],
    };
    mockApi.im.loadOlderMessages.mockResolvedValueOnce({
      messages: [mk('m0', 'old', 5)],
      eventsByMessage: olderEvents,
      hasMore: false,
    });

    await useImStore.getState().loadOlder('!r:localhost');

    // m0 应已被 hydrate 到 stream.store
    const s0 = useStreamStore.getState().streams.get('m0');
    expect(s0).toBeDefined();
    expect(s0!.messageId).toBe('m0');
    expect(s0!.status).toBe('done');
  });

  it('loadOlder 对边界重复的 messageId 不重复 hydrate（已是最新，覆盖式写入幂等）', async () => {
    // 初始化：m1 已在 stream.store
    mockApi.im.getMessages.mockResolvedValueOnce({
      messages: [mk('m1', 'a', 10)],
      eventsByMessage: {
        m1: [mkEvent('e1', 'm1', 0)],
      },
    });
    await useImStore.getState().selectRoom('!r:localhost');
    expect(useStreamStore.getState().streams.get('m1')).toBeDefined();

    // 翻页：m1 在边界重复推送——新加 final event
    const olderEvents: Record<string, MessageEventRow[]> = {
      m1: [
        mkEvent('e1', 'm1', 0),
        { ...mkEvent('e-final', 'm1', 1), eventType: 'final', payload: {} },
      ],
    };
    mockApi.im.loadOlderMessages.mockResolvedValueOnce({
      messages: [mk('m1', 'dup', 5)],
      eventsByMessage: olderEvents,
      hasMore: false,
    });

    await useImStore.getState().loadOlder('!r:localhost');

    // m1 应被 hydrate 覆盖——final 事件后 status=done
    const s1 = useStreamStore.getState().streams.get('m1');
    expect(s1).toBeDefined();
    expect(s1!.status).toBe('done');
  });
});

describe('im.store — 流式→持久化替换', () => {
  beforeEach(() => {
    useStreamStore.setState({ streams: new Map() });
  });

  it('收到 agent 最终消息时写入列表（StreamState 由 MessageList 通过 streamSessionId 去重处理）', () => {
    // 预置一个活跃流式会话（A 子系统：streams Map keyed by messageId）
    useStreamStore.setState({
      streams: new Map([
        [
          'sess-1',
          {
            thinking: '',
            text: '流式中...',
            toolCalls: [],
            todos: [],
            dispatches: [],
            status: 'streaming' as const,
            events: [],
            messageId: 'sess-1',
            startedAt: Date.now(),
          },
        ],
      ]),
    });
    expect(useStreamStore.getState().streams.has('sess-1')).toBe(true);

    // 推送 agent 最终消息（带 streamSessionId——A 子系统：来自 SQLite messages.streamSessionId 字段）
    const finalMsg = mk('m-final', '最终回复', 10);
    finalMsg.streamSessionId = 'sess-1';
    useImStore.getState().receiveMessage(finalMsg);

    // StreamState 保留（不再 clearCompleted——AgentStreamBubble 完成后仍渲染）
    expect(useStreamStore.getState().streams.has('sess-1')).toBe(true);
    // 消息应已写入列表
    expect(useImStore.getState().messagesByRoom.get('!r:localhost')).toContainEqual(finalMsg);
  });

  it('重复回放的消息不重复写入消息列表', () => {
    const finalMsg = mk('m-dup', '回复', 11);

    // 第一次推送
    useImStore.getState().receiveMessage(finalMsg);

    // 第二次推送相同 id：去重，不再写入
    useImStore.getState().receiveMessage(finalMsg);
    const msgs = useImStore.getState().messagesByRoom.get('!r:localhost') ?? [];
    expect(msgs.filter((m) => m.id === 'm-dup')).toHaveLength(1);
  });

  it('不含 streamSessionId 的消息不影响流式状态', () => {
    useStreamStore.setState({
      streams: new Map([
        [
          'sess-3',
          {
            thinking: '',
            text: '',
            toolCalls: [],
            todos: [],
            dispatches: [],
            status: 'streaming' as const,
            events: [],
            messageId: 'sess-3',
            startedAt: Date.now(),
          },
        ],
      ]),
    });

    const normalMsg = mk('m-normal', '普通消息', 12);
    useImStore.getState().receiveMessage(normalMsg);

    expect(useStreamStore.getState().streams.has('sess-3')).toBe(true);
  });
});
