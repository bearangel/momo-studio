// renderer/src/stores/im.store.ts
//
// IM 状态管理：房间列表 + 消息流 + 发送。
// 消息来源有两条路径：
//  1. 主动拉取：selectRoom → ipc.im.getMessages（历史消息 + eventsByMessage）
//  2. 被动接收：主进程推送 → onMessage / onMessageEventBatch → store action（实时消息）
//
// v2.0 A 子系统：消息唯一真相源切换到 SQLite。
//   - messages 表是消息正文（id / body / sender / createdAt...）
//   - message_events 表是流式事件溯源（thinking_delta / tool_call_start...）
//   - renderer 通过 stream-aggregator 的 aggregateEvents(events) 重建 StreamState
//   - 实时显示（增量 events 推送）和重启显示（一次性 loadAll events）走同一份聚合逻辑
//   - 不再从 Matrix event content 提取 io.momo-studio.* 富字段
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { ImMessage, ImRoomInfo, MessageEventRow, RoomMember } from '../ipc/types';
import { useStreamStore } from './stream.store';

interface ImState {
  rooms: ImRoomInfo[];
  activeRoomId: string | null;
  messagesByRoom: Map<string, ImMessage[]>;
  /** A 子系统：messageId → events（流式事件溯源，按 seq 升序） */
  eventsByMessage: Map<string, MessageEventRow[]>;
  members: RoomMember[];
  loading: boolean;
  error: string | null;
  /** 当前 rooms 所属的 workspace ID；切换 workspace 时重置全部 IM 状态 */
  currentWorkspaceId: string | null;
  /** v1.5.4：分页加载状态——roomId → 是否正在加载更早消息（防抖） */
  loadingOlderByRoom: Map<string, boolean>;
  /** v1.5.4：分页是否还有更早历史——roomId → boolean；undefined 视为 true（初始） */
  hasMoreByRoom: Map<string, boolean>;
  /** v1.5.7：team room 消息缓存——DispatchChip 跨房间搜索子 agent 消息 */
  teamRoomMessages: ImMessage[];

  /**
   * 拉取房间列表，默认激活第一个房间并加载其消息。
   * workspaceId 与当前不同时先重置状态（清空 rooms/messages/active room），
   * 保证切换工作空间后旧 workspace 的房间不会残留显示。
   */
  loadRooms: (workspaceId?: string) => Promise<void>;
  /** 房间列表刷新：立即拉一次 + 延迟再拉一次（兜底 /sync 延迟，避免 create/rename/dissolve 后列表陈旧） */
  refreshRoomList: (workspaceId?: string) => void;
  /** 切换激活房间并加载该房间历史消息与成员 */
  selectRoom: (roomId: string) => Promise<void>;
  /** v1.5.7: 加载 team room 消息（DispatchChip 跨房间搜索子 agent 消息） */
  loadTeamRoomMessages: () => Promise<void>;
  /** 拉取指定房间成员列表（含身份标识） */
  loadMembers: (roomId: string) => Promise<void>;
  /** 接收主进程推送的实时消息（按 SQLite messages.id 去重） */
  receiveMessage: (msg: ImMessage) => void;
  /**
   * A 子系统：接收主进程 MessageEventBuffer flush 推送的批量 events。
   * 按 eventsByMessage 累积，同 event id 不重复。
   */
  onIncomingEventBatch: (batch: MessageEventRow[]) => void;
  /** 向当前激活房间发送消息 */
  sendMessage: (body: string) => Promise<void>;
  /** v1.5.4：向前翻页加载更早历史（用户滚到顶部触发；防抖 + 到底短路） */
  loadOlder: (roomId: string) => Promise<void>;
  /** 重置全部状态（登出时调用） */
  reset: () => void;
}

export const useImStore = create<ImState>((set, get) => ({
  rooms: [],
  activeRoomId: null,
  messagesByRoom: new Map(),
  eventsByMessage: new Map(),
  members: [],
  loading: false,
  error: null,
  currentWorkspaceId: null,
  loadingOlderByRoom: new Map(),
  hasMoreByRoom: new Map(),
  teamRoomMessages: [],

  loadRooms: async (workspaceId) => {
    // 切换 workspace 时清空旧 workspace 的房间、消息、成员、激活房间
    if (workspaceId && workspaceId !== get().currentWorkspaceId) {
      set({
        currentWorkspaceId: workspaceId,
        rooms: [],
        activeRoomId: null,
        messagesByRoom: new Map(),
        eventsByMessage: new Map(),
        members: [],
      });
    }
    set({ loading: true, error: null });
    try {
      const roomList = await ipc.im.getRooms(workspaceId);
      // 保留当前选中房间（若仍存在）；仅初次加载或选中房间消失才回退首条
      const cur = get().activeRoomId;
      const stillThere = cur != null && roomList.some((r) => r.roomId === cur);
      const activeId = stillThere ? cur : (roomList[0]?.roomId ?? null);
      set({ rooms: roomList, activeRoomId: activeId, loading: false });
      // 仅选中房间变更时才重载消息流，避免刷新时闪烁
      if (activeId && activeId !== cur) {
        await get().selectRoom(activeId);
      }
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  // 房间列表刷新：立即拉一次 + 延迟再拉一次（兜底 /sync 延迟，避免 create/rename/dissolve 后列表陈旧）
  refreshRoomList: (workspaceId) => {
    void get().loadRooms(workspaceId);
    setTimeout(() => {
      void get().loadRooms(workspaceId);
    }, 1000);
  },

  selectRoom: async (roomId) => {
    set({ activeRoomId: roomId, loading: true });
    // v1.5.4：仅当 store 内没有该房间消息时才拉取（首次进入）。
    // 切回已访问过的房间时保留之前分页加载的全部消息，避免被 getMessages 的 limit 截断覆盖。
    // 实时新消息由 receiveMessage 主动追加，无需重新拉取。
    const hasMessages = get().messagesByRoom.has(roomId);
    if (hasMessages) {
      set({ loading: false });
    } else {
      try {
        const { messages, eventsByMessage } = await ipc.im.getMessages(roomId);
        // A8 fix：把 events 灌入 stream.store，让重启后能从 events 重建 StreamState。
        // 否则 MessageBubble 查 stream.store.get(message.id) 返回 undefined，所有历史
        // agent 消息都只渲染 message.body，thinking/toolCalls/dispatches 富信息不显示。
        for (const [msgId, evs] of Object.entries(eventsByMessage)) {
          useStreamStore.getState().hydrateFromEvents(msgId, evs);
        }
        set((state) => {
          const msgMap = new Map(state.messagesByRoom);
          msgMap.set(roomId, messages);
          const evMap = new Map(state.eventsByMessage);
          for (const [msgId, evs] of Object.entries(eventsByMessage)) {
            evMap.set(msgId, evs);
          }
          // hasMore 初始保持 undefined（视为 true）——SQLite listMessagesByRoom 默认
          // limit=1000，小房间也不能断定无更多历史。首次 loadOlder 调用会用 IPC 返回的
          // hasMore 字段（基于本批是否填满 count）赋权威值。
          return { messagesByRoom: msgMap, eventsByMessage: evMap, loading: false };
        });
      } catch (err) {
        set({ loading: false, error: (err as Error).message });
      }
    }
    // 放在 try 外：即使消息拉取失败也刷新成员，避免显示上个房间的陈旧成员
    void get().loadMembers(roomId);
    // v1.5.7: 加载 team room 消息（DispatchChip 跨房间搜索子 agent 消息用）
    void get().loadTeamRoomMessages();
  },

  loadTeamRoomMessages: async () => {
    try {
      const { useWorkspaceStore } = await import('./workspace.store');
      const ws = useWorkspaceStore.getState().getActive();
      if (!ws?.teamRoomId) return;
      const { messages } = await ipc.im.getMessages(ws.teamRoomId);
      set({ teamRoomMessages: messages });
    } catch {
      // 静默失败——team room 消息是辅助数据
    }
  },

  loadOlder: async (roomId) => {
    // 防抖：已在加载中跳过
    if (get().loadingOlderByRoom.get(roomId)) return;
    // 到底短路：服务端明确告知无更多历史时跳过
    if (get().hasMoreByRoom.get(roomId) === false) return;

    const existing = get().messagesByRoom.get(roomId) ?? [];
    if (existing.length === 0) return;
    // A 子系统：用当前可见消息的最小 createdAt 作为 beforeTs
    const beforeTs = existing.reduce((min, m) => Math.min(min, m.createdAt), Number.MAX_SAFE_INTEGER);

    set((s) => ({ loadingOlderByRoom: new Map(s.loadingOlderByRoom).set(roomId, true) }));
    try {
      const result = await ipc.im.loadOlderMessages(roomId, beforeTs, 30);
      // A8 fix：翻页拉到更早消息的 events 也要灌入 stream.store（与 selectRoom 一致）。
      // hydrateFromEvents 是幂等覆盖式写入，边界重复推送同一 messageId 也安全。
      for (const [msgId, evs] of Object.entries(result.eventsByMessage)) {
        useStreamStore.getState().hydrateFromEvents(msgId, evs);
      }
      set((s) => {
        const map = new Map(s.messagesByRoom);
        const cur = map.get(roomId) ?? [];
        // 前置拼接：新拉到的更早消息排在已有消息之前
        // 去重：服务端偶尔在边界重复推送已有消息，按 SQLite messages.id 过滤
        const existingIds = new Set(cur.map((m) => m.id));
        const dedupedNew = result.messages.filter((m) => !existingIds.has(m.id));
        map.set(roomId, [...dedupedNew, ...cur]);

        const evMap = new Map(s.eventsByMessage);
        for (const [msgId, evs] of Object.entries(result.eventsByMessage)) {
          evMap.set(msgId, evs);
        }

        const loading = new Map(s.loadingOlderByRoom).set(roomId, false);
        const hasMore = new Map(s.hasMoreByRoom).set(roomId, result.hasMore);
        return {
          messagesByRoom: map,
          eventsByMessage: evMap,
          loadingOlderByRoom: loading,
          hasMoreByRoom: hasMore,
        };
      });
    } catch {
      set((s) => ({ loadingOlderByRoom: new Map(s.loadingOlderByRoom).set(roomId, false) }));
    }
  },

  loadMembers: async (roomId) => {
    try {
      const members = await ipc.im.getMembers(roomId);
      set({ members });
    } catch {
      set({ members: [] });
    }
  },

  receiveMessage: (msg) => {
    set((state) => {
      const map = new Map(state.messagesByRoom);
      const existing = map.get(msg.roomId) ?? [];
      // 按 SQLite messages.id 去重，避免初始同步回放与推送重复
      if (existing.some((m) => m.id === msg.id)) {
        return state;
      }
      map.set(msg.roomId, [...existing, msg]);
      return { messagesByRoom: map };
    });
    // A 子系统：流式→持久化由 MessageList 通过 streamSessionId 去重处理，
    // 不再在此处读 Matrix content 字段（content 已废弃）。
  },

  onIncomingEventBatch: (batch) => {
    if (batch.length === 0) return;
    set((state) => {
      const evMap = new Map(state.eventsByMessage);
      for (const e of batch) {
        const list = evMap.get(e.messageId) ?? [];
        // 同 event id 不重复（flush 边界回放保护）
        if (list.some((x) => x.id === e.id)) continue;
        evMap.set(e.messageId, [...list, e]);
      }
      return { eventsByMessage: evMap };
    });
  },

  sendMessage: async (body) => {
    const { activeRoomId } = get();
    if (!activeRoomId) return;
    // 不做本地乐观插入：SDK local echo 经 sync-manager 推回 receiveMessage（自带正确 sender）。
    // 手动乐观会因 id 不可去重 + sender='' 错误归属，产生"别人重复我的消息"幻影。
    await ipc.im.send(activeRoomId, body);
  },

  reset: () =>
    set({
      rooms: [],
      activeRoomId: null,
      messagesByRoom: new Map(),
      eventsByMessage: new Map(),
      members: [],
      loading: false,
      error: null,
      currentWorkspaceId: null,
      loadingOlderByRoom: new Map(),
      hasMoreByRoom: new Map(),
    }),
}));

/**
 * A 子系统：全局 IM 通道订阅。
 * 在 App.tsx 顶层调用一次，订阅两条通道：
 *   - im:message           → 实时消息（含本地 echo、agent 最终消息）
 *   - im:message_event_batch → 流式 events 批量推送（thinking/tool_call 等增量）
 * 同一份 event batch 同时喂给 im.store（累积到 eventsByMessage，重启还原用）
 * 和 stream.store（聚合到 streams，UI 实时渲染用），保证两条路径数据一致。
 * 返回 unsubscribe 函数。
 */
export function subscribeImChannels(): () => void {
  const off1 = ipc.im.onMessage((msg) => useImStore.getState().receiveMessage(msg));
  const off2 = ipc.im.onMessageEventBatch((batch) => {
    useImStore.getState().onIncomingEventBatch(batch);
    useStreamStore.getState().applyEventBatch(batch);
  });
  return () => {
    off1();
    off2();
  };
}
