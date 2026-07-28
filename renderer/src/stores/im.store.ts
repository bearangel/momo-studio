// renderer/src/stores/im.store.ts
//
// IM 状态管理：房间列表 + 消息流 + 发送。
// 消息来源有两条路径：
//  1. 主动拉取：selectRoom → ipc.im.getMessages（历史消息）
//  2. 被动接收：主进程 /sync 推送 → onMessage → receiveMessage（实时消息）
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { ImMessage, ImRoomInfo } from '../ipc/types';

interface ImState {
  rooms: ImRoomInfo[];
  activeRoomId: string | null;
  messagesByRoom: Map<string, ImMessage[]>;
  loading: boolean;
  error: string | null;

  /** 拉取房间列表，默认激活第一个房间并加载其消息 */
  loadRooms: () => Promise<void>;
  /** 切换激活房间并加载该房间历史消息 */
  selectRoom: (roomId: string) => Promise<void>;
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
  loading: false,
  error: null,

  loadRooms: async () => {
    set({ loading: true, error: null });
    try {
      const roomList = await ipc.im.getRooms();
      const activeId = roomList.length > 0 ? roomList[0]!.roomId : null;
      set({ rooms: roomList, activeRoomId: activeId, loading: false });
      if (activeId) {
        await get().selectRoom(activeId);
      }
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
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
  },

  receiveMessage: (msg) => {
    set((state) => {
      const map = new Map(state.messagesByRoom);
      const existing = map.get(msg.roomId) ?? [];
      // 按 eventId 去重，避免初始同步回放与推送重复
      if (existing.some((m) => m.eventId === msg.eventId)) {
        return state;
      }
      map.set(msg.roomId, [...existing, msg]);
      return { messagesByRoom: map };
    });
  },

  sendMessage: async (body) => {
    const { activeRoomId } = get();
    if (!activeRoomId) return;
    await ipc.im.send(activeRoomId, body);
  },

  reset: () =>
    set({
      rooms: [],
      activeRoomId: null,
      messagesByRoom: new Map(),
      loading: false,
      error: null,
    }),
}));
