// renderer/src/stores/im.store.ts
//
// IM 状态管理：房间列表 + 消息流 + 发送。
// 消息来源有两条路径：
//  1. 主动拉取：selectRoom → ipc.im.getMessages（历史消息）
//  2. 被动接收：主进程 /sync 推送 → onMessage → receiveMessage（实时消息）
//
// v1.4：receiveMessage 收到带 io.momo-studio.stream_session_id 的 agent 最终消息时，
//   调用 stream.store.clearCompleted 移除对应的临时流式气泡——即"流式→持久化替换"。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { ImMessage, ImRoomInfo, RoomMember } from '../ipc/types';
import { useStreamStore } from './stream.store';

/** Matrix event content 中标记 agent 最终回复的自定义键（值=streamSessionId） */
const STREAM_SESSION_ID_KEY = 'io.momo-studio.stream_session_id';

interface ImState {
  rooms: ImRoomInfo[];
  activeRoomId: string | null;
  messagesByRoom: Map<string, ImMessage[]>;
  members: RoomMember[];
  loading: boolean;
  error: string | null;
  /** 当前 rooms 所属的 workspace ID；切换 workspace 时重置全部 IM 状态 */
  currentWorkspaceId: string | null;

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
  /** 拉取指定房间成员列表（含身份标识） */
  loadMembers: (roomId: string) => Promise<void>;
  /** 接收主进程推送的实时消息（去重） */
  receiveMessage: (msg: ImMessage) => void;
  /** 向当前激活房间发送消息 */
  sendMessage: (body: string) => Promise<void>;
  /** 重置全部状态（登出时调用） */
  reset: () => void;
}

export const useImStore = create<ImState>((set, get) => ({
  rooms: [],
  activeRoomId: null,
  messagesByRoom: new Map(),
  members: [],
  loading: false,
  error: null,
  currentWorkspaceId: null,

  loadRooms: async (workspaceId) => {
    // 切换 workspace 时清空旧 workspace 的房间、消息、成员、激活房间
    if (workspaceId && workspaceId !== get().currentWorkspaceId) {
      set({
        currentWorkspaceId: workspaceId,
        rooms: [],
        activeRoomId: null,
        messagesByRoom: new Map(),
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
    try {
      const messages = await ipc.im.getMessages(roomId);
      set((state) => {
        const map = new Map(state.messagesByRoom);
        map.set(roomId, messages);
        return { messagesByRoom: map, loading: false };
      });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
    // 放在 try 外：即使消息拉取失败也刷新成员，避免显示上个房间的陈旧成员
    void get().loadMembers(roomId);
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
    let wasNew = false;
    set((state) => {
      const map = new Map(state.messagesByRoom);
      const existing = map.get(msg.roomId) ?? [];
      // 按 eventId 去重，避免初始同步回放与推送重复
      if (existing.some((m) => m.eventId === msg.eventId)) {
        return state;
      }
      map.set(msg.roomId, [...existing, msg]);
      wasNew = true;
      return { messagesByRoom: map };
    });

    // 流式→持久化替换：agent 最终消息（带 stream_session_id）到达时，
    // 清理对应的临时流式气泡。重复回放的消息不重复触发（其流式态早已清理）。
    if (wasNew) {
      const sessionId = msg.content[STREAM_SESSION_ID_KEY];
      if (typeof sessionId === 'string' && sessionId) {
        useStreamStore.getState().clearCompleted(sessionId);
      }
    }
  },

  sendMessage: async (body) => {
    const { activeRoomId } = get();
    if (!activeRoomId) return;
    // 不做本地乐观插入：SDK local echo 经 sync-manager 推回 receiveMessage（自带正确 sender）。
    // 手动乐观会因 eventId 不可去重 + sender='' 错误归属，产生"别人重复我的消息"幻影。
    await ipc.im.send(activeRoomId, body);
  },

  reset: () =>
    set({
      rooms: [],
      activeRoomId: null,
      messagesByRoom: new Map(),
      members: [],
      loading: false,
      error: null,
      currentWorkspaceId: null,
    }),
}));
