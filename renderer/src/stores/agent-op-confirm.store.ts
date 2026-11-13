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
    // 乐观消卡（D1，2026-11-13 真机两轮复现）：裁决先到先得，主进程侧
    // 10 分钟超时 / child 退出兜底拒绝——消卡不等 invoke 回包。实测首笔回包
    // 可能迟迟不达（裁决已被受理落库），等待会让模态遮罩阻塞整页数分钟；
    // 先消卡，IPC 明确 reject 时恢复本卡供重试。
    set({ pending: null });
    try {
      // skipped=true（他窗先到/已超时）无需处理——本卡本就应已关闭，静默收敛
      await ipc.agent.replyAgentOpConfirm(p.requestId, allowed);
    } catch {
      // 回执确定失败：恢复本卡供重试。若期间已有新请求顶上（单卡覆盖式）
      // 则不覆盖新卡——旧请求由主进程超时兜底拒绝，不静默吞状态。
      const cur = get().pending;
      if (cur === null || cur.requestId === p.requestId) set({ pending: p });
    }
  },

  dismissExpired: () => {
    const p = get().pending;
    if (p && Date.now() >= p.expiresAt) set({ pending: null });
  },

  __resetForTest: () => set({ pending: null }),
}));
