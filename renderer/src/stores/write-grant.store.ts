// renderer/src/stores/write-grant.store.ts
// 通用写授权卡状态（spec 2026-10-03 §5.3/§7）：pending = 未处置的 writeBlocked
// 事件（覆盖式单卡——事件风暴同 dirs 去重）。
//
// 2026-10-14 后台链授权卡死根因修复（F1/F2/F3）：
// - F1 空 dirs 不进拒绝记忆：旧实现拒绝后记 `'∅|'`（sessionId null + dirs 空）
//   通配键，此后同会话所有提取失败的拦截全部静默 → waitForWriteGrant 无限等
//   （真机实录：子链僵死 13 分钟靠手动 cancelChain 救援）
// - F2 拒绝记忆加 TTL：保留「防事件风暴重复弹卡」本意，去掉永久静默——同键
//   5 分钟内不重复弹，过期可再询（用户态度可能改变）
// - F3 waitingByStream：等待授权的流位图（streamSessionId → 事件），供在途
//   面板/派单 chip 呈现「等待授权」态与行内处置；条目 15 分钟惰性过期清扫
import { create } from 'zustand';
import type { WriteBlockedEvent } from '../ipc/types';

/** 拒绝记忆 TTL（同键静默窗口） */
const DENIED_MEMORY_TTL_MS = 5 * 60_000;
/** 等待条目过期（对齐 F5 等待超时 10min + 缓冲；过期后面板回归执行中态） */
const WAITING_ENTRY_TTL_MS = 15 * 60_000;

const deniedKeys = new Map<string, number>();
const denyKey = (e: WriteBlockedEvent): string => `${e.sessionId ?? '∅'}|${e.dirs.join(',')}`;

interface WaitingEntry {
  event: WriteBlockedEvent;
  receivedAt: number;
}

interface WriteGrantState {
  pending: WriteBlockedEvent | null;
  /** streamSessionId → 等待中的授权事件（F3：面板/chip 等待态数据源） */
  waitingByStream: Map<string, WaitingEntry>;
  receiveWriteBlocked: (e: WriteBlockedEvent) => void;
  denyPending: () => void;
  resolvePending: () => void;
  /** 行内处置（F3）：授权或拒绝后按流清除等待条目 */
  clearWaiting: (streamSessionId: string) => void;
  __resetForTest: () => void;
}

function sweepExpiredWaiting(map: Map<string, WaitingEntry>): Map<string, WaitingEntry> {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of map) {
    if (now - v.receivedAt > WAITING_ENTRY_TTL_MS) {
      map.delete(k);
      changed = true;
    }
  }
  return changed ? new Map(map) : map;
}

export const useWriteGrantStore = create<WriteGrantState>((set, get) => ({
  pending: null,
  waitingByStream: new Map(),

  receiveWriteBlocked: (e) => {
    // F1+F2：只有带明确 dirs 的事件才查拒绝记忆（且记忆带 TTL）；
    // 空 dirs（提取失败）永远重新弹卡——静默它就是制造无限等待
    if (e.dirs.length > 0) {
      const ts = deniedKeys.get(denyKey(e));
      if (ts !== undefined && Date.now() - ts < DENIED_MEMORY_TTL_MS) return;
    }
    const waiting = new Map(get().waitingByStream);
    if (e.streamSessionId !== null && e.streamSessionId !== '') {
      waiting.set(e.streamSessionId, { event: e, receivedAt: Date.now() });
    }
    set({ pending: e, waitingByStream: sweepExpiredWaiting(waiting) });
  },

  denyPending: () => {
    const p = get().pending;
    // F1：空 dirs 不记忆（通配键塌缩根因）
    if (p && p.dirs.length > 0) deniedKeys.set(denyKey(p), Date.now());
    const waiting = new Map(get().waitingByStream);
    if (p?.streamSessionId) waiting.delete(p.streamSessionId);
    set({ pending: null, waitingByStream: waiting });
  },

  resolvePending: () => {
    const p = get().pending;
    const waiting = new Map(get().waitingByStream);
    if (p?.streamSessionId) waiting.delete(p.streamSessionId);
    set({ pending: null, waitingByStream: waiting });
  },

  clearWaiting: (streamSessionId) => {
    const waiting = new Map(get().waitingByStream);
    if (waiting.delete(streamSessionId)) set({ waitingByStream: waiting });
  },

  __resetForTest: () => {
    deniedKeys.clear();
    set({ pending: null, waitingByStream: new Map() });
  },
}));
