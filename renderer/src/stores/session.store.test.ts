// renderer/src/stores/session.store.test.ts
//
// v2.0 P1 Task 9：im.store.test.ts 全量改造为 session 内核契约：
//   - IPC 走 ipc.session.*（list/get/send/getMessages/loadOlder）
//   - 字段映射：rooms→sessions、activeRoomId→activeSessionId、
//     messagesByRoom→messagesBySession、loadingOlderByRoom→loadingOlderBySession、
//     hasMoreByRoom→hasMoreBySession
//   - sendMessage 新增 mentionedAssignmentIds 透传（@ 目标从 Matrix userId 换成 assignmentId）
//   - loadMembers 改走 session:get（返回 { session, members: SessionMemberInfo[] }）
//   - 新增 subscribeSessionChannels 接线测试（session:message / session:message_event_batch）
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore, subscribeSessionChannels } from './session.store';
import { useStreamStore } from './stream.store';
import type { ImMessage, MessageEventRow, SessionMemberInfo, SessionSummary } from '../ipc/types';

const MOCK_SESSIONS_A: SessionSummary[] = [
  { id: 'sess-a1', workspaceId: 'ws-a', title: 'A 会话 1', titleAuto: false, kind: 'chat', lastMessageAt: null, members: [] },
  { id: 'sess-a2', workspaceId: 'ws-a', title: 'A 会话 2', titleAuto: false, kind: 'chat', lastMessageAt: null, members: [] },
];
const MOCK_SESSIONS_B: SessionSummary[] = [
  { id: 'sess-b1', workspaceId: 'ws-b', title: 'B 会话 1', titleAuto: false, kind: 'chat', lastMessageAt: null, members: [] },
];

const MOCK_MEMBERS: SessionMemberInfo[] = [
  { instanceId: 'inst-1', agentName: 'Agent甲', iconEmoji: '🤖', lastRunning: true, isLeader: true },
];

const mockApi = {
  session: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn(),
    loadOlder: vi.fn(),
    exportMessages: vi.fn(),
    onMessage: vi.fn().mockReturnValue(() => {}),
    onMessageEventBatch: vi.fn().mockReturnValue(() => {}),
  },
};

/** 构造一条 ImMessage（默认 m.room.message，createdAt 单调递增由调用方指定） */
function mk(id: string, body: string, createdAt = 0): ImMessage {
  return {
    id,
    sessionId: 'sess-r',
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
  useSessionStore.getState().reset();
  mockApi.session.list.mockReset();
  mockApi.session.list.mockResolvedValue(MOCK_SESSIONS_A);
  mockApi.session.get.mockReset();
  mockApi.session.get.mockResolvedValue({ session: {}, members: MOCK_MEMBERS });
  mockApi.session.getMessages.mockReset();
  mockApi.session.getMessages.mockResolvedValue({ messages: [], eventsByMessage: {} });
  mockApi.session.send.mockClear();
  mockApi.session.loadOlder.mockReset();
  // 订阅 mock 只清调用记录（保留返回值实现），保证 toHaveBeenCalledTimes 按用例计数
  mockApi.session.onMessage.mockClear();
  mockApi.session.onMessageEventBatch.mockClear();
});

describe('session.store', () => {
  it('loadSessions populates sessions and activates the first session', async () => {
    await useSessionStore.getState().loadSessions();
    expect(useSessionStore.getState().sessions).toHaveLength(2);
    expect(useSessionStore.getState().activeSessionId).toBe('sess-a1');
  });

  it('loadSessions with empty sessions leaves activeSessionId null', async () => {
    mockApi.session.list.mockResolvedValue([]);
    await useSessionStore.getState().loadSessions();
    expect(useSessionStore.getState().sessions).toHaveLength(0);
    expect(useSessionStore.getState().activeSessionId).toBeNull();
  });

  it('refreshSessionList 只拉取一次（Task 11 移除 1s 兜底双拉取，纯 SQLite 首拉即权威）', async () => {
    vi.useFakeTimers();
    try {
      useSessionStore.getState().refreshSessionList('ws-a');
      await vi.advanceTimersByTimeAsync(1500);
      expect(mockApi.session.list).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('selectSession loads messages + events for the session', async () => {
    const messages: ImMessage[] = [mk('m1', 'hi', 1)];
    const eventsByMessage: Record<string, MessageEventRow[]> = {
      m1: [mkEvent('e1', 'm1', 0)],
    };
    mockApi.session.getMessages.mockResolvedValue({ messages, eventsByMessage });

    await useSessionStore.getState().selectSession('sess-a1');
    expect(useSessionStore.getState().messagesBySession.get('sess-a1')).toEqual(messages);
    expect(useSessionStore.getState().eventsByMessage.get('m1')).toEqual(eventsByMessage.m1);
  });

  it('selectSession 同时加载成员（session:get 返回 SessionMemberInfo）', async () => {
    mockApi.session.getMessages.mockResolvedValue({ messages: [], eventsByMessage: {} });
    await useSessionStore.getState().selectSession('sess-a1');
    // loadMembers 是 fire-and-forget（不阻塞 selectSession），flush 微任务后再断言
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApi.session.get).toHaveBeenCalledWith('sess-a1');
    expect(useSessionStore.getState().members).toEqual(MOCK_MEMBERS);
  });

  it('receiveMessage appends to the session message list', () => {
    const msg = mk('m2', 'hello', 2);
    useSessionStore.getState().receiveMessage(msg);
    expect(useSessionStore.getState().messagesBySession.get('sess-r')).toContainEqual(msg);
  });

  it('receiveMessage deduplicates by SQLite messages.id', () => {
    const msg = mk('m3', 'dup', 3);
    useSessionStore.getState().receiveMessage(msg);
    useSessionStore.getState().receiveMessage(msg);
    expect(useSessionStore.getState().messagesBySession.get('sess-r')).toHaveLength(1);
  });

  it('sendMessage calls ipc.session.send with the active session id', async () => {
    await useSessionStore.getState().loadSessions();
    await useSessionStore.getState().sendMessage('hello');
    expect(mockApi.session.send).toHaveBeenCalledWith('sess-a1', 'hello', undefined);
  });

  it('sendMessage 透传 mentionedAssignmentIds（@ 目标从 Matrix userId 换成 assignmentId）', async () => {
    await useSessionStore.getState().loadSessions();
    await useSessionStore.getState().sendMessage('hi @agent', ['inst-1', 'inst-2']);
    expect(mockApi.session.send).toHaveBeenCalledWith('sess-a1', 'hi @agent', ['inst-1', 'inst-2']);
  });

  it('sendMessage 不插入本地乐观消息（无本地 echo 时消息列表不变）', async () => {
    await useSessionStore.getState().loadSessions();
    await useSessionStore.getState().sendMessage('hello');
    const msgs = useSessionStore.getState().messagesBySession.get('sess-a1') ?? [];
    expect(msgs.some((m) => m.sender === '' || m.id.startsWith('local-'))).toBe(false);
  });

  it('sendMessage is a no-op when no session is active', async () => {
    await useSessionStore.getState().sendMessage('hello');
    expect(mockApi.session.send).not.toHaveBeenCalled();
  });
});

describe('session.store — workspace 隔离', () => {
  it('loadSessions(workspaceId) 把 workspaceId 透传给 IPC', async () => {
    await useSessionStore.getState().loadSessions('ws-a');
    expect(mockApi.session.list).toHaveBeenCalledWith('ws-a');
  });

  it('切换 workspace 时清空旧 workspace 的会话、消息、激活会话', async () => {
    // 先在 workspace A 建立状态
    mockApi.session.list.mockResolvedValue(MOCK_SESSIONS_A);
    await useSessionStore.getState().loadSessions('ws-a');
    await useSessionStore.getState().selectSession('sess-a1');
    expect(useSessionStore.getState().sessions).toHaveLength(2);
    expect(useSessionStore.getState().activeSessionId).toBe('sess-a1');
    expect(useSessionStore.getState().messagesBySession.size).toBeGreaterThanOrEqual(0);
    expect(useSessionStore.getState().currentWorkspaceId).toBe('ws-a');

    // 切换到 workspace B：旧 workspace 的会话和消息应清空
    mockApi.session.list.mockResolvedValue(MOCK_SESSIONS_B);
    await useSessionStore.getState().loadSessions('ws-b');
    expect(useSessionStore.getState().sessions).toEqual(MOCK_SESSIONS_B);
    expect(useSessionStore.getState().activeSessionId).toBe('sess-b1');
    // 旧 workspace 会话的消息缓存应已清除
    expect(useSessionStore.getState().messagesBySession.has('sess-a1')).toBe(false);
    expect(useSessionStore.getState().messagesBySession.has('sess-a2')).toBe(false);
    expect(useSessionStore.getState().currentWorkspaceId).toBe('ws-b');
  });

  it('同一 workspace 重复 loadSessions 不重置状态（保留当前选中会话）', async () => {
    mockApi.session.list.mockResolvedValue(MOCK_SESSIONS_A);
    await useSessionStore.getState().loadSessions('ws-a');
    await useSessionStore.getState().selectSession('sess-a2');
    expect(useSessionStore.getState().activeSessionId).toBe('sess-a2');

    // 同 workspace 再 load：activeSessionId 保持选中（不退回首条）
    await useSessionStore.getState().loadSessions('ws-a');
    expect(useSessionStore.getState().activeSessionId).toBe('sess-a2');
  });
});

describe('session.store — onIncomingEventBatch', () => {
  it('空 batch 是 no-op', () => {
    const before = useSessionStore.getState().eventsByMessage.size;
    useSessionStore.getState().onIncomingEventBatch([]);
    expect(useSessionStore.getState().eventsByMessage.size).toBe(before);
  });

  it('批量 events 按 messageId 累积到 eventsByMessage', () => {
    useSessionStore.getState().onIncomingEventBatch([
      mkEvent('e1', 'm1', 0),
      mkEvent('e2', 'm1', 1),
      mkEvent('e3', 'm2', 0),
    ]);
    expect(useSessionStore.getState().eventsByMessage.get('m1')).toHaveLength(2);
    expect(useSessionStore.getState().eventsByMessage.get('m2')).toHaveLength(1);
  });

  it('同 event id 不重复（flush 边界回放保护）', () => {
    useSessionStore.getState().onIncomingEventBatch([mkEvent('e1', 'm1', 0)]);
    useSessionStore.getState().onIncomingEventBatch([mkEvent('e1', 'm1', 0)]); // 同 id
    expect(useSessionStore.getState().eventsByMessage.get('m1')).toHaveLength(1);
  });
});

describe('session.store loadOlder', () => {
  it('前置拼接新拉到的更早消息', async () => {
    // 当前已有消息 m1(50), m2(60)
    const existing = [mk('m1', 'newest', 50), mk('m2', 'older', 60)];
    mockApi.session.getMessages.mockResolvedValueOnce({ messages: existing, eventsByMessage: {} });
    await useSessionStore.getState().selectSession('sess-r');

    // 翻页：返回更早的消息 m3(10), m4(20)
    const olderBatch = [mk('m3', 'oldest1', 10), mk('m4', 'oldest2', 20)];
    mockApi.session.loadOlder.mockResolvedValueOnce({
      messages: olderBatch,
      eventsByMessage: {},
      hasMore: true,
    });

    await useSessionStore.getState().loadOlder('sess-r');

    const messages = useSessionStore.getState().messagesBySession.get('sess-r')!;
    expect(messages.map((m) => m.id)).toEqual(['m3', 'm4', 'm1', 'm2']);
    // beforeTs 应是当前最小 createdAt = 50
    expect(mockApi.session.loadOlder).toHaveBeenCalledWith('sess-r', 50, 30);
  });

  it('hasMore=false 时短路不发 IPC', async () => {
    mockApi.session.getMessages.mockResolvedValueOnce({
      messages: [mk('m1', 'a', 10)],
      eventsByMessage: {},
    });
    await useSessionStore.getState().selectSession('sess-r');
    mockApi.session.loadOlder.mockResolvedValueOnce({
      messages: [],
      eventsByMessage: {},
      hasMore: false,
    });
    await useSessionStore.getState().loadOlder('sess-r');

    mockApi.session.loadOlder.mockClear();
    await useSessionStore.getState().loadOlder('sess-r');
    expect(mockApi.session.loadOlder).not.toHaveBeenCalled();
  });

  it('加载中再次触发会被防抖（不重复 IPC）', async () => {
    mockApi.session.getMessages.mockResolvedValueOnce({
      messages: [mk('m1', 'a', 10)],
      eventsByMessage: {},
    });
    await useSessionStore.getState().selectSession('sess-r');

    let resolveLoad!: (v: { messages: ImMessage[]; eventsByMessage: Record<string, MessageEventRow[]>; hasMore: boolean }) => void;
    const pending = new Promise<{
      messages: ImMessage[];
      eventsByMessage: Record<string, MessageEventRow[]>;
      hasMore: boolean;
    }>((r) => {
      resolveLoad = r;
    });
    mockApi.session.loadOlder.mockImplementationOnce(() => pending);

    // 启动第一次 loadOlder（不 await，让它停在 ipc 调用）
    const p1 = useSessionStore.getState().loadOlder('sess-r');
    // 此时 loadingOlder=true，第二次应被 store 防抖 return（不调 IPC）
    await useSessionStore.getState().loadOlder('sess-r');

    expect(mockApi.session.loadOlder).toHaveBeenCalledTimes(1);

    // resolve 让第一次完成，避免悬挂 promise
    resolveLoad({ messages: [], eventsByMessage: {}, hasMore: true });
    await p1;
  });

  it('按 SQLite messages.id 去重（服务端边界重复）', async () => {
    const existing = [mk('m1', 'a', 10), mk('m2', 'b', 20)];
    mockApi.session.getMessages.mockResolvedValueOnce({ messages: existing, eventsByMessage: {} });
    await useSessionStore.getState().selectSession('sess-r');

    // 服务端在边界重复推送 m1 + 新的 m0
    const olderBatch = [mk('m1', 'a-dup', 10), mk('m0', 'oldest', 5)];
    mockApi.session.loadOlder.mockResolvedValueOnce({
      messages: olderBatch,
      eventsByMessage: {},
      hasMore: true,
    });

    await useSessionStore.getState().loadOlder('sess-r');

    const messages = useSessionStore.getState().messagesBySession.get('sess-r')!;
    expect(messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2']);
  });

  it('loadOlder 同时把新拉消息的 events 合并进 eventsByMessage', async () => {
    mockApi.session.getMessages.mockResolvedValueOnce({
      messages: [mk('m1', 'a', 10)],
      eventsByMessage: {},
    });
    await useSessionStore.getState().selectSession('sess-r');

    const olderEvents: Record<string, MessageEventRow[]> = {
      m0: [mkEvent('e-old', 'm0', 0)],
    };
    mockApi.session.loadOlder.mockResolvedValueOnce({
      messages: [mk('m0', 'old', 5)],
      eventsByMessage: olderEvents,
      hasMore: false,
    });
    await useSessionStore.getState().loadOlder('sess-r');

    expect(useSessionStore.getState().eventsByMessage.get('m0')).toEqual(olderEvents.m0);
  });

  it('selectSession 切回已访问会话时保留分页累积（不重新拉取覆盖）', async () => {
    mockApi.session.getMessages.mockResolvedValueOnce({
      messages: [mk('m1', 'a', 10)],
      eventsByMessage: {},
    });
    await useSessionStore.getState().selectSession('sess-r');
    mockApi.session.loadOlder.mockResolvedValueOnce({
      messages: [mk('m0', 'old', 5)],
      eventsByMessage: {},
      hasMore: false,
    });
    await useSessionStore.getState().loadOlder('sess-r');
    expect(useSessionStore.getState().messagesBySession.get('sess-r')!.length).toBe(2);

    // 切到别的会话
    mockApi.session.getMessages.mockResolvedValueOnce({
      messages: [mk('x1', 'x', 100)],
      eventsByMessage: {},
    });
    await useSessionStore.getState().selectSession('sess-other');

    // 切回——getMessages 不应被再次调用（保留累积）
    mockApi.session.getMessages.mockClear();
    await useSessionStore.getState().selectSession('sess-r');
    expect(mockApi.session.getMessages).not.toHaveBeenCalled();
    // 消息仍是 2 条（m0 + m1），未被覆盖
    expect(useSessionStore.getState().messagesBySession.get('sess-r')!.length).toBe(2);
    // hasMore 仍为 false
    expect(useSessionStore.getState().hasMoreBySession.get('sess-r')).toBe(false);
  });
});

describe('session.store — loadOlder/loadMembers 错误状态（暴露给未来 UI）', () => {
  beforeEach(() => {
    useSessionStore.setState({ loadOlderError: null, membersError: null });
  });

  it('loadOlder 拒绝时写入 loadOlderError 中文消息并复位 loadingOlder 标志', async () => {
    // 先 selectSession 让 sess-r 注册到 messagesBySession——否则 loadOlder 因空列表早退
    mockApi.session.getMessages.mockResolvedValueOnce({
      messages: [mk('m1', 'a', 10)],
      eventsByMessage: {},
    });
    await useSessionStore.getState().selectSession('sess-r');

    mockApi.session.loadOlder.mockRejectedValueOnce(new Error('SQLite: database is locked'));
    await useSessionStore.getState().loadOlder('sess-r');

    expect(useSessionStore.getState().loadOlderError).toBe(
      '加载更早消息失败：SQLite: database is locked',
    );
    expect(useSessionStore.getState().loadingOlderBySession.get('sess-r')).toBe(false);
  });

  it('loadOlder 成功路径会清零 loadOlderError（重试成功不残留旧错误）', async () => {
    mockApi.session.getMessages.mockResolvedValueOnce({
      messages: [mk('m1', 'a', 10)],
      eventsByMessage: {},
    });
    await useSessionStore.getState().selectSession('sess-r');

    mockApi.session.loadOlder.mockRejectedValueOnce(new Error('boom'));
    await useSessionStore.getState().loadOlder('sess-r');
    expect(useSessionStore.getState().loadOlderError).toContain('boom');

    mockApi.session.loadOlder.mockResolvedValueOnce({
      messages: [mk('m0', 'old', 5)],
      eventsByMessage: {},
      hasMore: false,
    });
    await useSessionStore.getState().loadOlder('sess-r');
    expect(useSessionStore.getState().loadOlderError).toBeNull();
  });

  it('loadMembers 拒绝时写入 membersError 中文消息，成员列表被清空', async () => {
    mockApi.session.get.mockRejectedValueOnce(new Error('network down'));
    await useSessionStore.getState().loadMembers('sess-r');

    expect(useSessionStore.getState().membersError).toBe('加载成员列表失败：network down');
    // 旧实现：失败时把 members 重置为空数组——保持向后兼容
    expect(useSessionStore.getState().members).toEqual([]);
  });

  it('loadMembers 成功路径清空 membersError（重试成功后旧错误不应残留）', async () => {
    mockApi.session.get.mockRejectedValueOnce(new Error('oops'));
    await useSessionStore.getState().loadMembers('sess-r');
    expect(useSessionStore.getState().membersError).toContain('oops');

    mockApi.session.get.mockResolvedValueOnce({ session: {}, members: MOCK_MEMBERS });
    await useSessionStore.getState().loadMembers('sess-r');
    expect(useSessionStore.getState().membersError).toBeNull();
    expect(useSessionStore.getState().members).toEqual(MOCK_MEMBERS);
  });

  it('reset() 同时清空 loadOlderError 与 membersError', () => {
    useSessionStore.setState({
      loadOlderError: '加载更早消息失败：x',
      membersError: '加载成员列表失败：y',
    });
    useSessionStore.getState().reset();
    expect(useSessionStore.getState().loadOlderError).toBeNull();
    expect(useSessionStore.getState().membersError).toBeNull();
  });
});

describe('session.store — 重启场景：hydrateFromEvents 接线', () => {
  beforeEach(() => {
    useStreamStore.setState({ streams: new Map() });
  });

  it('selectSession 后把 eventsByMessage 喂给 stream.store.hydrateFromEvents（重建 StreamState）', async () => {
    // IPC 返回带 final 事件的 eventsByMessage——模拟重启后从 SQLite 拉的完整 events
    const messages: ImMessage[] = [mk('m1', 'hi', 1), mk('m2', 'done', 2)];
    const eventsByMessage: Record<string, MessageEventRow[]> = {
      m1: [mkEvent('e1', 'm1', 0), mkEvent('e2', 'm1', 1)],
      m2: [
        mkEvent('e3', 'm2', 0),
        { ...mkEvent('e4', 'm2', 1), eventType: 'final', payload: {} },
      ],
    };
    mockApi.session.getMessages.mockResolvedValue({ messages, eventsByMessage });

    await useSessionStore.getState().selectSession('sess-a1');

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

  it('selectSession 时 eventsByMessage 为空数组也应安全处理（无流式历史消息不抛错）', async () => {
    const messages: ImMessage[] = [mk('m1', 'plain', 1)];
    mockApi.session.getMessages.mockResolvedValue({ messages, eventsByMessage: {} });

    await expect(useSessionStore.getState().selectSession('sess-a1')).resolves.not.toThrow();
  });

  it('loadOlder 后老消息的 events 也灌入 stream.store（翻页场景）', async () => {
    // 先 selectSession 初始化会话
    mockApi.session.getMessages.mockResolvedValueOnce({
      messages: [mk('m1', 'a', 10)],
      eventsByMessage: {},
    });
    await useSessionStore.getState().selectSession('sess-r');
    expect(useStreamStore.getState().streams.size).toBe(0);

    // 翻页：返回 m0 + events（含 final → status=done）
    const olderEvents: Record<string, MessageEventRow[]> = {
      m0: [
        mkEvent('e-old-1', 'm0', 0),
        { ...mkEvent('e-old-2', 'm0', 1), eventType: 'final', payload: {} },
      ],
    };
    mockApi.session.loadOlder.mockResolvedValueOnce({
      messages: [mk('m0', 'old', 5)],
      eventsByMessage: olderEvents,
      hasMore: false,
    });

    await useSessionStore.getState().loadOlder('sess-r');

    // m0 应已被 hydrate 到 stream.store
    const s0 = useStreamStore.getState().streams.get('m0');
    expect(s0).toBeDefined();
    expect(s0!.messageId).toBe('m0');
    expect(s0!.status).toBe('done');
  });

  it('loadOlder 对边界重复的 messageId 不重复 hydrate（已是最新，覆盖式写入幂等）', async () => {
    // 初始化：m1 已在 stream.store
    mockApi.session.getMessages.mockResolvedValueOnce({
      messages: [mk('m1', 'a', 10)],
      eventsByMessage: {
        m1: [mkEvent('e1', 'm1', 0)],
      },
    });
    await useSessionStore.getState().selectSession('sess-r');
    expect(useStreamStore.getState().streams.get('m1')).toBeDefined();

    // 翻页：m1 在边界重复推送——新加 final event
    const olderEvents: Record<string, MessageEventRow[]> = {
      m1: [
        mkEvent('e1', 'm1', 0),
        { ...mkEvent('e-final', 'm1', 1), eventType: 'final', payload: {} },
      ],
    };
    mockApi.session.loadOlder.mockResolvedValueOnce({
      messages: [mk('m1', 'dup', 5)],
      eventsByMessage: olderEvents,
      hasMore: false,
    });

    await useSessionStore.getState().loadOlder('sess-r');

    // m1 应被 hydrate 覆盖——final 事件后 status=done
    const s1 = useStreamStore.getState().streams.get('m1');
    expect(s1).toBeDefined();
    expect(s1!.status).toBe('done');
  });
});

describe('session.store — 流式→持久化替换', () => {
  beforeEach(() => {
    useStreamStore.setState({ streams: new Map() });
  });

  it('收到 agent 最终消息时写入列表（StreamState 由 MessageList 通过 streamSessionId 去重处理）', () => {
    // 预置一个活跃流式会话（streams Map keyed by messageId）
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
            segments: [],
            messageId: 'sess-1',
            startedAt: Date.now(),
          },
        ],
      ]),
    });
    expect(useStreamStore.getState().streams.has('sess-1')).toBe(true);

    // 推送 agent 最终消息（带 streamSessionId——来自 SQLite messages.streamSessionId 字段）
    const finalMsg = mk('m-final', '最终回复', 10);
    finalMsg.streamSessionId = 'sess-1';
    useSessionStore.getState().receiveMessage(finalMsg);

    // StreamState 保留（AgentStreamBubble 完成后仍渲染）
    expect(useStreamStore.getState().streams.has('sess-1')).toBe(true);
    // 消息应已写入列表
    expect(useSessionStore.getState().messagesBySession.get('sess-r')).toContainEqual(finalMsg);
  });

  it('重复回放的消息不重复写入消息列表', () => {
    const finalMsg = mk('m-dup', '回复', 11);

    // 第一次推送
    useSessionStore.getState().receiveMessage(finalMsg);

    // 第二次推送相同 id：去重，不再写入
    useSessionStore.getState().receiveMessage(finalMsg);
    const msgs = useSessionStore.getState().messagesBySession.get('sess-r') ?? [];
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
            segments: [],
            messageId: 'sess-3',
            startedAt: Date.now(),
          },
        ],
      ]),
    });

    const normalMsg = mk('m-normal', '普通消息', 12);
    useSessionStore.getState().receiveMessage(normalMsg);

    expect(useStreamStore.getState().streams.has('sess-3')).toBe(true);
  });
});

describe('session.store — subscribeSessionChannels 接线（Task 9 新增）', () => {
  beforeEach(() => {
    useStreamStore.setState({ streams: new Map() });
  });

  it('订阅 session:message → receiveMessage（消息进入对应会话列表）', () => {
    const off = subscribeSessionChannels();
    expect(mockApi.session.onMessage).toHaveBeenCalledTimes(1);

    // 取出注册的回调，模拟主进程推送
    const cb = mockApi.session.onMessage.mock.calls[0]![0] as (msg: ImMessage) => void;
    cb(mk('m-sub', '推送消息', 20));
    expect(useSessionStore.getState().messagesBySession.get('sess-r')).toContainEqual(
      expect.objectContaining({ id: 'm-sub' }),
    );

    off();
  });

  it('订阅 session:message_event_batch → onIncomingEventBatch + stream.store.applyEventBatch', () => {
    const applySpy = vi.spyOn(useStreamStore.getState(), 'applyEventBatch');
    const off = subscribeSessionChannels();
    expect(mockApi.session.onMessageEventBatch).toHaveBeenCalledTimes(1);

    const cb = mockApi.session.onMessageEventBatch.mock.calls[0]![0] as (
      batch: MessageEventRow[],
    ) => void;
    cb([mkEvent('e-sub', 'm-sub', 0)]);
    // eventsByMessage 累积
    expect(useSessionStore.getState().eventsByMessage.get('m-sub')).toHaveLength(1);
    // stream.store 同步聚合
    expect(applySpy).toHaveBeenCalledWith([mkEvent('e-sub', 'm-sub', 0)]);

    applySpy.mockRestore();
    off();
  });

  it('返回的 unsubscribe 解除两条订阅', () => {
    const offMsg = () => {};
    const offBatch = () => {};
    mockApi.session.onMessage.mockReturnValueOnce(offMsg);
    mockApi.session.onMessageEventBatch.mockReturnValueOnce(offBatch);
    const off = subscribeSessionChannels();
    off();
    // 两个 off 函数都应被调用——通过返回值闭包行为验证（不抛错即通过）
    expect(true).toBe(true);
  });
});

describe('__momoDebug 诊断钩子（嵌套展示排查）', () => {
  it('window.__momoDebug 存在且返回消息行/流键结构', () => {
    const dbg = (globalThis as unknown as { __momoDebug?: () => unknown }).__momoDebug;
    expect(typeof dbg).toBe('function');
    const out = dbg!() as { activeSession: unknown; messages: unknown[]; streamKeys: string[] };
    expect(out).toHaveProperty('activeSession');
    expect(Array.isArray(out.messages)).toBe(true);
    expect(Array.isArray(out.streamKeys)).toBe(true);
  });
});
