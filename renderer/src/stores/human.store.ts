// renderer/src/stores/human.store.ts
//
// 人工请求域状态（任务生命周期 v2 Task 22，spec 2026-11-13）：
//   - pendingBySession：会话 → 未决请求列表（human.list 默认 status='pending'，
//     按 created_at ASC——面板按请求先后展示，与 repo listPendingBySession 同序）
//   - attentionBySession：会话注意力聚合（waiting / submitted / executorSubmitted /
//     failed——T23 会话列表徽标数据源，本任务先落通道）
//   - 订阅（initSubscriptions，消费方挂载时调用一次）：
//     · human.onChanged → 受影响会话重拉 pending。事件风暴（同请求连续
//       inserted/answered、多请求并发）按 sessionId 合并单次重拉——
//       sessionId+requestId 维度的重复天然被会话级合并覆盖（REFETCH_COALESCE_MS
//       窗口内的全部事件只触发一次 loadPending）
//     · task.onTaskRunChanged → 兜底刷新（T16 carry：run 收尾顶替 supersede /
//       任务取消 cancel 通路只改 run 状态不发 human:changed 推送——runChanged
//       是这些路径的唯一信号）。载荷只有 taskId/runId/status 无 sessionId，
//       无法定点，刷新全部已跟踪会话（窗口合并后代价可控）
//     · 两类事件均顺带合并刷新 attention（T23：徽标/待处理分区数据源，任务态
//       翻转与未打开会话的等待计数变化也需反映——见 scheduleAttentionRefresh）
//   - 答复经 answer 单点：ipc.human.answer + 该会话 pending 立即重拉（不等
//     onChanged 推送，答完卡片原地消失）；acceptance 请求不走此通道（验收在
//     面板直调 task.accept / task.reject，主进程 answerAcceptance 会发
//     human:changed 走订阅刷新）
import { create } from 'zustand';
import type { HumanAnswerInput, HumanRequestRow, SessionAttention } from '../ipc/types';
import { ipc } from '../ipc/client';

/** 事件合并窗口：窗口内的 human:changed / runChanged 只触发一次重拉 */
const REFETCH_COALESCE_MS = 100;

/** 待重拉会话集合 + 冲刷定时器（模块级——订阅回调与 store 实例解耦） */
const dirtySessions = new Set<string>();
let flushTimer: number | null = null;

function scheduleRefetch(sessionId: string, loadPending: (sid: string) => Promise<void>): void {
  dirtySessions.add(sessionId);
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    const sessions = Array.from(dirtySessions);
    dirtySessions.clear();
    for (const sid of sessions) void loadPending(sid);
  }, REFETCH_COALESCE_MS);
}

/** 最近一次 attention 刷新的工作空间（订阅事件载荷无 workspaceId，兜底刷新复用） */
let attentionWorkspaceId: string | null = null;
/** attention 兜底刷新合并定时器（与 pending 重拉同窗口，模块级同因） */
let attentionTimer: number | null = null;

/**
 * 徽标聚合兜底刷新（onChanged / runChanged 事件后调，T23）：等待中计数 /
 * submitted / failed 变化必须反映到会话列表徽标与「待处理」分区——runChanged
 * 兜底原本只刷 pending，任务态翻转（supersede / cancel 连带的 submitted→failed
 * 等）在徽标面上会失真，故事件后顺带整表刷 attention。与 pending 重拉共用
 * REFETCH_COALESCE_MS 窗口合并；RoomList 挂载建立 workspace 上下文前静默跳过。
 */
function scheduleAttentionRefresh(refresh: (workspaceId: string) => Promise<void>): void {
  if (attentionWorkspaceId === null) return;
  if (attentionTimer !== null) return;
  attentionTimer = window.setTimeout(() => {
    attentionTimer = null;
    void refresh(attentionWorkspaceId!);
  }, REFETCH_COALESCE_MS);
}

/** 订阅防重入标记 + 退订句柄（__resetForTest 复位） */
let subscribed = false;
let offHumanChanged: (() => void) | null = null;
let offTaskRunChanged: (() => void) | null = null;

interface HumanState {
  pendingBySession: Map<string, HumanRequestRow[]>;
  attentionBySession: Record<string, SessionAttention>;
  /** 拉取会话未决请求（human.list 默认 pending；失败静默保持既有值） */
  loadPending: (sessionId: string) => Promise<void>;
  /** 刷新工作空间会话注意力聚合（整体替换；失败静默） */
  refreshAttention: (workspaceId: string) => Promise<void>;
  /**
   * 答复人工请求（tool_gate / question / manual_action）；acceptance 请求
   * 主进程人话拒（走 task.accept / task.reject）。答后立即重拉所属会话。
   */
  answer: (
    requestId: string,
    answer: HumanAnswerInput,
    message?: string,
  ) => Promise<'answered' | 'stale'>;
  /** 挂载即调（幂等）：human.onChanged + task.onTaskRunChanged 订阅 */
  initSubscriptions: () => void;
  __resetForTest: () => void;
}

export const useHumanStore = create<HumanState>((set, get) => ({
  pendingBySession: new Map(),
  attentionBySession: {},

  loadPending: async (sessionId) => {
    try {
      const rows = await ipc.human.list({ sessionId });
      const next = new Map(get().pendingBySession);
      next.set(sessionId, rows);
      set({ pendingBySession: next });
    } catch {
      // 拉取失败保持既有值——面板下次事件/挂载重试，不因瞬时 IPC 错误清空卡片
    }
  },

  refreshAttention: async (workspaceId) => {
    // 记住最近工作空间：订阅事件载荷无 workspaceId，兜底刷新复用此上下文
    attentionWorkspaceId = workspaceId;
    try {
      const attention = await ipc.human.attention(workspaceId);
      set({ attentionBySession: attention });
    } catch {
      // 同上：聚合失败静默（徽标数据源，非关键路径）
    }
  },

  answer: async (requestId, answer, message) => {
    // 反查所属会话用于答后重拉（pending 行必然在某个已跟踪会话内）
    let sessionId: string | null = null;
    for (const [sid, rows] of get().pendingBySession) {
      if (rows.some((r) => r.id === requestId)) {
        sessionId = sid;
        break;
      }
    }
    const res = await ipc.human.answer(requestId, answer, message);
    if (sessionId !== null) await get().loadPending(sessionId);
    return res.disposition;
  },

  initSubscriptions: () => {
    if (subscribed) return;
    subscribed = true;
    offHumanChanged = ipc.human.onChanged((e) => {
      // 只刷新已跟踪会话（pendingBySession 有键）——未打开过的会话不因
      // 后台事件产生无谓拉取；面板挂载即 loadPending 建键
      if (get().pendingBySession.has(e.sessionId)) {
        scheduleRefetch(e.sessionId, get().loadPending);
      }
      // 徽标数据源兜底：未打开过的会话同样可能产生等待中计数——attention
      // 整表刷新不分定点（T23）
      scheduleAttentionRefresh(get().refreshAttention);
    });
    offTaskRunChanged = ipc.task.onTaskRunChanged(() => {
      // T16 carry 兜底：supersede / cancel 通路无 human:changed 推送，
      // runChanged 是唯一信号；载荷无 sessionId → 全部已跟踪会话合并刷新
      for (const sid of get().pendingBySession.keys()) {
        scheduleRefetch(sid, get().loadPending);
      }
      // 任务态翻转（submitted / failed）经此通路落定——attention 顺带刷新（T23）
      scheduleAttentionRefresh(get().refreshAttention);
    });
  },

  __resetForTest: () => {
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (attentionTimer !== null) {
      window.clearTimeout(attentionTimer);
      attentionTimer = null;
    }
    attentionWorkspaceId = null;
    dirtySessions.clear();
    offHumanChanged?.();
    offHumanChanged = null;
    offTaskRunChanged?.();
    offTaskRunChanged = null;
    subscribed = false;
    set({ pendingBySession: new Map(), attentionBySession: {} });
  },
}));
