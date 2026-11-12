// renderer/src/stores/agent-op-confirm.store.ts
// 扩权确认卡状态（spec 2026-11-12 §7）：pending = 未处置的 agent-op-confirm:request
// 推送（覆盖式单卡，write-grant.store 同款）。回执走 replyAgentOpConfirm——
// 先到先得（他窗已裁决返回 skipped:true 同样清卡）；expiresAt 到点主进程侧
// 超时拒绝，卡面经 dismissExpired 同步清扫（组件挂 1s interval 调用）。
import { create } from 'zustand';
import type { AgentOpConfirmPayload } from '../ipc/types';
import { ipc } from '../ipc/client';

interface AgentOpConfirmState {
  pending: AgentOpConfirmPayload | null;
  receive: (payload: AgentOpConfirmPayload) => void;
  reply: (allowed: boolean) => Promise<void>;
  /** TTL 清扫：pending 已过 expiresAt 即清（receive 时与组件 interval 双入口） */
  dismissExpired: () => void;
  __resetForTest: () => void;
}

export const useAgentOpConfirmStore = create<AgentOpConfirmState>((set, get) => ({
  pending: null,

  receive: (payload) => {
    // 到达即过期（推送延迟等）——不弹卡，主进程侧超时兜底拒绝
    if (Date.now() >= payload.expiresAt) return;
    set({ pending: payload });
  },

  reply: async (allowed) => {
    const p = get().pending;
    if (!p) return;
    try {
      // skipped=true（他窗先到/已超时）也清卡——本卡本就应已关闭，静默收敛
      await ipc.agent.replyAgentOpConfirm(p.requestId, allowed);
    } catch {
      // IPC 失败：卡保留可重试；主进程侧 10 分钟超时兜底拒绝，不静默吞状态
      return;
    }
    set({ pending: null });
  },

  dismissExpired: () => {
    const p = get().pending;
    if (p && Date.now() >= p.expiresAt) set({ pending: null });
  },

  __resetForTest: () => set({ pending: null }),
}));
