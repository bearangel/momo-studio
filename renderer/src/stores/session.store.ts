// renderer/src/stores/session.store.ts
//
// 会话状态管理：会话列表 + 消息流 + 发送（v2.0 P1 Task 9，由 im.store 全量改造）。
// 数据源切换到 session 内核（纯 SQLite，无 Matrix）：
//  1. 主动拉取：selectSession → ipc.session.getMessages（历史消息 + eventsByMessage）
//  2. 被动接收：主进程推送 → session.onMessage / onMessageEventBatch → store action
//
// v2.0 A 子系统：消息唯一真相源是 SQLite。
//   - messages 表是消息正文（id / body / sender / createdAt...）
//   - message_events 表是流式事件溯源（thinking_delta / tool_call_start...）
//   - renderer 通过 stream-aggregator 的 aggregateEvents(events) 重建 StreamState
//   - 实时显示（增量 events 推送）和重启显示（一次性 loadAll events）走同一份聚合逻辑
//
// 与 im.store 的差异：
//   - IPC 全部走 ipc.session.*（list/get/send/getMessages/loadOlder）
//   - 不再有 im:startSync 启动步骤（无 Matrix /sync）
//   - sendMessage 增加 mentionedAssignmentIds（@ 目标从 Matrix userId 换成 assignmentId）
//   - 成员来自 session:get 的 SessionMemberInfo（三表 JOIN，仅 agent 成员）
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { ImMessage, MessageEventRow, SessionMemberInfo, SessionSummary } from '../ipc/types';
import { useStreamStore } from './stream.store';

interface SessionState {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  messagesBySession: Map<string, ImMessage[]>;
  /** A 子系统：messageId → events（流式事件溯源，按 seq 升序） */
  eventsByMessage: Map<string, MessageEventRow[]>;
  members: SessionMemberInfo[];
  loading: boolean;
  error: string | null;
  /** 当前 sessions 所属的 workspace ID；切换 workspace 时重置全部状态 */
  currentWorkspaceId: string | null;
  /** 分页加载状态——sessionId → 是否正在加载更早消息（防抖） */
  loadingOlderBySession: Map<string, boolean>;
  /** 分页是否还有更早历史——sessionId → boolean；undefined 视为 true（初始） */
  hasMoreBySession: Map<string, boolean>;

  /**
   * 拉取会话列表，默认激活第一个会话并加载其消息。
   * workspaceId 与当前不同时先重置状态（清空 sessions/messages/active session），
   * 保证切换工作空间后旧 workspace 的会话不会残留显示。
   */
  loadSessions: (workspaceId?: string) => Promise<void>;
  /** 会话列表刷新：立即拉一次（纯 SQLite 首拉即权威，无推送延迟需要兜底） */
  refreshSessionList: (workspaceId?: string) => void;
  /** 切换激活会话并加载该会话历史消息与成员 */
  selectSession: (sessionId: string) => Promise<void>;
  /** 拉取指定会话成员列表（agent 成员，含运行态与协调标识） */
  loadMembers: (sessionId: string) => Promise<void>;
  /** 接收主进程推送的实时消息（按 SQLite messages.id 去重） */
  receiveMessage: (msg: ImMessage) => void;
  /**
   * A 子系统：接收主进程 MessageEventBuffer flush 推送的批量 events。
   * 按 eventsByMessage 累积，同 event id 不重复。
   */
  onIncomingEventBatch: (batch: MessageEventRow[]) => void;
  /** 向当前激活会话发送消息（mentionedAssignmentIds 为 @ 的 assignment 实例） */
  sendMessage: (body: string, mentionedAssignmentIds?: string[]) => Promise<void>;
  /** 向前翻页加载更早历史（用户滚到顶部触发；防抖 + 到底短路） */
  loadOlder: (sessionId: string) => Promise<void>;
  /** 重置全部状态（登出时调用） */
  reset: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messagesBySession: new Map(),
  eventsByMessage: new Map(),
  members: [],
  loading: false,
  error: null,
  currentWorkspaceId: null,
  loadingOlderBySession: new Map(),
  hasMoreBySession: new Map(),

  loadSessions: async (workspaceId) => {
    // 切换 workspace 时清空旧 workspace 的会话、消息、成员、激活会话
    if (workspaceId && workspaceId !== get().currentWorkspaceId) {
      set({
        currentWorkspaceId: workspaceId,
        sessions: [],
        activeSessionId: null,
        messagesBySession: new Map(),
        eventsByMessage: new Map(),
        members: [],
      });
    }
    set({ loading: true, error: null });
    try {
      const sessionList = await ipc.session.list(workspaceId);
      // 保留当前选中会话（若仍存在）；仅初次加载或选中会话消失才回退首条
      const cur = get().activeSessionId;
      const stillThere = cur != null && sessionList.some((s) => s.id === cur);
      const activeId = stillThere ? cur : (sessionList[0]?.id ?? null);
      set({ sessions: sessionList, activeSessionId: activeId, loading: false });
      // 仅选中会话变更时才重载消息流，避免刷新时闪烁
      if (activeId && activeId !== cur) {
        await get().selectSession(activeId);
      }
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  // 纯 SQLite 读路径：首拉即权威，无 Matrix /sync 推送延迟需要二次兜底
  refreshSessionList: (workspaceId) => {
    void get().loadSessions(workspaceId);
  },

  selectSession: async (sessionId) => {
    set({ activeSessionId: sessionId, loading: true });
    // 仅当 store 内没有该会话消息时才拉取（首次进入）。
    // 切回已访问过的会话时保留之前分页加载的全部消息，避免被 getMessages 的 limit 截断覆盖。
    // 实时新消息由 receiveMessage 主动追加，无需重新拉取。
    const hasMessages = get().messagesBySession.has(sessionId);
    if (hasMessages) {
      set({ loading: false });
    } else {
      try {
        const { messages, eventsByMessage } = await ipc.session.getMessages(sessionId);
        // A8 fix：把 events 灌入 stream.store，让重启后能从 events 重建 StreamState。
        // 否则 MessageBubble 查 stream.store.get(message.id) 返回 undefined，所有历史
        // agent 消息都只渲染 message.body，thinking/toolCalls/dispatches 富信息不显示。
        for (const [msgId, evs] of Object.entries(eventsByMessage)) {
          useStreamStore.getState().hydrateFromEvents(msgId, evs);
        }
        set((state) => {
          const msgMap = new Map(state.messagesBySession);
          msgMap.set(sessionId, messages);
          const evMap = new Map(state.eventsByMessage);
          for (const [msgId, evs] of Object.entries(eventsByMessage)) {
            evMap.set(msgId, evs);
          }
          // hasMore 初始保持 undefined（视为 true）——listMessagesBySession 默认
          // limit=1000，小会话也不能断定无更多历史。首次 loadOlder 调用会用 IPC 返回的
          // hasMore 字段（基于本批是否填满 count）赋权威值。
          return { messagesBySession: msgMap, eventsByMessage: evMap, loading: false };
        });
      } catch (err) {
        set({ loading: false, error: (err as Error).message });
      }
    }
    // 放在 try 外：即使消息拉取失败也刷新成员，避免显示上个会话的陈旧成员
    void get().loadMembers(sessionId);
  },

  loadOlder: async (sessionId) => {
    // 防抖：已在加载中跳过
    if (get().loadingOlderBySession.get(sessionId)) return;
    // 到底短路：服务端明确告知无更多历史时跳过
    if (get().hasMoreBySession.get(sessionId) === false) return;

    const existing = get().messagesBySession.get(sessionId) ?? [];
    if (existing.length === 0) return;
    // A 子系统：用当前可见消息的最小 createdAt 作为 beforeTs
    const beforeTs = existing.reduce((min, m) => Math.min(min, m.createdAt), Number.MAX_SAFE_INTEGER);

    set((s) => ({ loadingOlderBySession: new Map(s.loadingOlderBySession).set(sessionId, true) }));
    try {
      const result = await ipc.session.loadOlder(sessionId, beforeTs, 30);
      // A8 fix：翻页拉到更早消息的 events 也要灌入 stream.store（与 selectSession 一致）。
      // hydrateFromEvents 是幂等覆盖式写入，边界重复推送同一 messageId 也安全。
      for (const [msgId, evs] of Object.entries(result.eventsByMessage)) {
        useStreamStore.getState().hydrateFromEvents(msgId, evs);
      }
      set((s) => {
        const map = new Map(s.messagesBySession);
        const cur = map.get(sessionId) ?? [];
        // 前置拼接：新拉到的更早消息排在已有消息之前
        // 去重：服务端偶尔在边界重复推送已有消息，按 SQLite messages.id 过滤
        const existingIds = new Set(cur.map((m) => m.id));
        const dedupedNew = result.messages.filter((m) => !existingIds.has(m.id));
        map.set(sessionId, [...dedupedNew, ...cur]);

        const evMap = new Map(s.eventsByMessage);
        for (const [msgId, evs] of Object.entries(result.eventsByMessage)) {
          evMap.set(msgId, evs);
        }

        const loading = new Map(s.loadingOlderBySession).set(sessionId, false);
        const hasMore = new Map(s.hasMoreBySession).set(sessionId, result.hasMore);
        return {
          messagesBySession: map,
          eventsByMessage: evMap,
          loadingOlderBySession: loading,
          hasMoreBySession: hasMore,
        };
      });
    } catch {
      set((s) => ({ loadingOlderBySession: new Map(s.loadingOlderBySession).set(sessionId, false) }));
    }
  },

  loadMembers: async (sessionId) => {
    try {
      const { members } = await ipc.session.get(sessionId);
      set({ members });
    } catch {
      set({ members: [] });
    }
  },

  receiveMessage: (msg) => {
    set((state) => {
      const map = new Map(state.messagesBySession);
      const existing = map.get(msg.sessionId) ?? [];
      // 按 SQLite messages.id 去重，避免初始同步回放与推送重复
      if (existing.some((m) => m.id === msg.id)) {
        return state;
      }
      map.set(msg.sessionId, [...existing, msg]);
      return { messagesBySession: map };
    });
    // A 子系统：流式→持久化由 MessageList 通过 streamSessionId 去重处理，
    // 不在此处读 Matrix content 字段（content 已废弃）。
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

  sendMessage: async (body, mentionedAssignmentIds) => {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    // 不做本地乐观插入：主进程落库后经 session:message 推回 receiveMessage。
    await ipc.session.send(activeSessionId, body, mentionedAssignmentIds);
  },

  reset: () =>
    set({
      sessions: [],
      activeSessionId: null,
      messagesBySession: new Map(),
      eventsByMessage: new Map(),
      members: [],
      loading: false,
      error: null,
      currentWorkspaceId: null,
      loadingOlderBySession: new Map(),
      hasMoreBySession: new Map(),
    }),
}));

/**
 * 全局会话通道订阅（在 App.tsx 顶层调用一次）。
 * 订阅 session 命名空间两条通道：
 *   - session:message             → 实时消息行（session-service / p2p 发送方统一走此通道）
 *   - session:message_event_batch → 流式 events 批量推送（thinking/tool_call 等增量）
 * 同一份 event batch 同时喂给 session.store（累积到 eventsByMessage，重启还原用）
 * 和 stream.store（聚合到 streams，UI 实时渲染用），保证两条路径数据一致。
 * 返回 unsubscribe 函数。
 */
export function subscribeSessionChannels(): () => void {
  const off1 = ipc.session.onMessage((msg) => useSessionStore.getState().receiveMessage(msg));
  const off2 = ipc.session.onMessageEventBatch((batch) => {
    useSessionStore.getState().onIncomingEventBatch(batch);
    useStreamStore.getState().applyEventBatch(batch);
  });
  return () => {
    off1();
    off2();
  };
}
