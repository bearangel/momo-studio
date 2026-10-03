// renderer/src/stores/write-grant.store.ts
// 通用写授权卡状态（spec 2026-10-03 §5.3/§7）：pending = 未处置的 writeBlocked
// 事件（覆盖式单卡——事件风暴同 dirs 去重）；拒绝按 会话+dirs 记忆（renderer
// 内存，重启自然遗忘可再询——agent 已从提示段得知等待用户决定）。
import { create } from 'zustand';
import type { WriteBlockedEvent } from '../ipc/types';

const deniedKeys = new Set<string>();
const denyKey = (e: WriteBlockedEvent): string => `${e.sessionId ?? '∅'}|${e.dirs.join(',')}`;

interface WriteGrantState {
  pending: WriteBlockedEvent | null;
  receiveWriteBlocked: (e: WriteBlockedEvent) => void;
  denyPending: () => void;
  resolvePending: () => void;
  __resetForTest: () => void;
}

export const useWriteGrantStore = create<WriteGrantState>((set, get) => ({
  pending: null,
  receiveWriteBlocked: (e) => {
    if (deniedKeys.has(denyKey(e))) return;
    set({ pending: e });
  },
  denyPending: () => {
    const p = get().pending;
    if (p) deniedKeys.add(denyKey(p));
    set({ pending: null });
  },
  resolvePending: () => set({ pending: null }),
  __resetForTest: () => {
    deniedKeys.clear();
    set({ pending: null });
  },
}));
