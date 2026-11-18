// renderer/src/stores/remote-session.view.ts
//
// 远端执行会话视图 store（spec 2026-11-17 §5/§7）：任务驱动临时打开（ui.store
// remoteSessionView 挂载），帧流 upsert（wire:2 协商）/legacy 降级双路径、
// 订阅生命周期（断线重订 + 尾后补拉——语义平移自 RemoteSessionDrawer 三条
// effect）、steer 乐观渲染与回流消解。本地零落库（只读红线 §8.4）。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import { humanizeViewError, VIEW_PAGE_SIZE } from './hub-view.store';
import type { HubViewFrame, HubViewMessage, ImMessage, TaskRow } from '../ipc/types';

export interface RemoteSessionTarget {
  targetNodeId: string;
  workspaceName: string;
  groupId: string | null;
  runNo: number;
  nodeName: string;
  sessionId: string;
}

export interface PendingSteer {
  id: string;
  text: string;
  state: 'sending' | 'sent' | 'failed';
  error?: string;
}

/** 节点短 id（>8 位掐头去尾；RemoteSessionDrawer 同款——抽屉退役后本 store 为单源） */
export function shortNodeId(nodeId: string): string {
  return nodeId.length > 8 ? `${nodeId.slice(0, 4)}…${nodeId.slice(-4)}` : nodeId;
}

interface RemoteSessionState {
  phase: 'resolving' | 'ready' | 'miss' | 'error';
  errorText: string | null;
  task: TaskRow | null;
  target: RemoteSessionTarget | null;
  wire2: boolean;
  frames: HubViewFrame[];
  legacy: HubViewMessage[];
  /** 本地跟踪会话镜像里程碑行（spec §12.2 穿插渲染 + 降级回落数据源） */
  mirrorRows: ImMessage[];
  hasMore: boolean;
  loadingEarlier: boolean;
  live: boolean;
  hubOnline: boolean;
  liveError: string | null;
  pendingSteers: PendingSteer[];
  open: (task: TaskRow) => Promise<void>;
  close: () => void;
  loadEarlier: () => void;
  sendSteer: (text: string) => Promise<void>;
  retrySteer: (id: string) => Promise<void>;
  dropSteer: (id: string) => void;
}

/** 帧去重键索引（frameId → 帧序号位置由渲染时排序保证，此处只存 Map） */
let disposeAppended: (() => void) | null = null;
let disposeState: (() => void) | null = null;

/** 已知尾 seq（帧路径取最大帧 seq；legacy 取末行 seq）——补拉 fromSeq 锚点 */
function knownLastSeq(frames: HubViewFrame[], legacy: HubViewMessage[]): number {
  const f = frames.length > 0 ? frames[frames.length - 1]!.seq : 0;
  const l = legacy.length > 0 ? legacy[legacy.length - 1]!.seq : 0;
  return Math.max(f, l);
}

/** steer 回流匹配（E2E 实录修正）：远端注入实际走「里程碑 notice」（system 行，
 *  投影为 assistant text 帧 / legacy assistant 行，content 带【发起方指令】前缀）；
 *  本地 runtime 分流才产生 steer 事件帧（content=原文）。两形态都认。 */
function steerEchoMatches(pendingText: string, echo: { kind?: string; role?: string; content?: string }): boolean {
  if (typeof echo.content !== 'string') return false;
  return echo.content === pendingText || echo.content === `【发起方指令】${pendingText}`;
}

/** 帧批 upsert（同 frameId 整帧替换；按 seq 升序输出） */
function upsertFrames(prev: HubViewFrame[], incoming: HubViewFrame[]): HubViewFrame[] {
  if (incoming.length === 0) return prev;
  const map = new Map(prev.map((f) => [f.frameId, f]));
  for (const f of incoming) map.set(f.frameId, f);
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

export const useRemoteSessionStore = create<RemoteSessionState>((set, get) => {
  const refetchMirror = (): void => {
    const t = get().task;
    if (t === null || t.executionSessionId === null || t.executionSessionId === '') return;
    void ipc.im
      .getMessages(t.executionSessionId)
      .then((r) => { set({ mirrorRows: r.messages }); })
      .catch(() => { /* 镜像行是增强面——拉取失败保旧值 */ });
  };

  const teardownListeners = (): void => {
    disposeAppended?.();
    disposeAppended = null;
    disposeState?.();
    disposeState = null;
    disposeRunChanged?.();
    disposeRunChanged = null;
  };

  let disposeRunChanged: (() => void) | null = null;

  const wireListeners = (): void => {
    if (disposeAppended !== null) return;
    // 任务态实时性（E2E 实录）：open() 时的 task 是快照——run 推送匹配本任务时
    // 刷新行，composer 终态门控（任务已结束）不依赖陈旧状态
    disposeRunChanged = ipc.task.onTaskRunChanged((e) => {
      const cur = get().task;
      if (!cur || cur.id !== e.taskId) return;
      void ipc.task
        .get(cur.id)
        .then((fresh) => { set({ task: fresh }); refetchMirror(); })
        .catch(() => { /* 刷新失败保旧态 */ });
    });
    disposeAppended = ipc.hub.onViewAppended((evt) => {
      const t = get().target;
      if (!t || t.sessionId !== evt.sessionId) return;
      if (evt.frames !== undefined && evt.frames.length > 0) {
        const frames = upsertFrames(get().frames, evt.frames);
        // steer 帧回流 → 消解同文最旧 sent pending（spec §7.3 去重键 kind+content）
        const pending = [...get().pendingSteers];
        for (const f of evt.frames) {
          if (f.kind !== 'steer' && f.kind !== 'text') continue;
          const i = pending.findIndex((p) => p.state !== 'failed' && steerEchoMatches(p.text, f));
          if (i >= 0) pending.splice(i, 1);
        }
        set({ frames, pendingSteers: pending, live: true, liveError: null });
        return;
      }
      if (evt.events.length > 0) {
        const known = new Set(get().legacy.map((m) => m.seq));
        const fresh = evt.events.filter((e) => !known.has(e.seq));
        // legacy steer 回流行消解（终审 Important#7）：旧投影把 steer 事件按
        // payload.body 落成 user 行——content 匹配最旧非 failed pending，防双显
        const pending = [...get().pendingSteers];
        for (const e of fresh) {
          if (e.role !== 'user' && e.role !== 'assistant') continue;
          const i = pending.findIndex((p) => p.state !== 'failed' && steerEchoMatches(p.text, e));
          if (i >= 0) pending.splice(i, 1);
        }
        if (fresh.length === 0 && pending.length === get().pendingSteers.length) return;
        set({ legacy: [...get().legacy, ...fresh], pendingSteers: pending, live: true, liveError: null });
      }
    });
    let prevOnline = true;
    disposeState = ipc.hub.onStateChanged((evt) => {
      const online = evt.state === 'online';
      set({ hubOnline: online });
      if (!online) set({ live: false });
      if (online && !prevOnline && !get().live) {
        const t = get().target;
        if (!t) return;
        const seg = t.groupId !== null ? { groupId: t.groupId } : {};
        void (async () => {
          await ipc.hub
            .viewUnsubscribe({ targetNodeId: t.targetNodeId, sessionId: t.sessionId, ...seg })
            .then(() => undefined, () => undefined);
          try {
            await ipc.hub.viewSubscribe({ targetNodeId: t.targetNodeId, sessionId: t.sessionId, ...seg, wire: 2 });
          } catch (err) {
            set({ liveError: humanizeViewError(err) });
            return;
          }
          set({ live: true, liveError: null });
          const after = knownLastSeq(get().frames, get().legacy);
          try {
            const raw = await ipc.hub.viewMessages({
              targetNodeId: t.targetNodeId, sessionId: t.sessionId, workspaceName: t.workspaceName,
              fromSeq: 0, limit: VIEW_PAGE_SIZE, ...seg, wire: 2, afterSeq: after,
            });
            if ('frames' in raw && raw.frames.length > 0) {
              set((s) => ({ frames: upsertFrames(s.frames, raw.frames) }));
            } else if ('messages' in raw && raw.messages.length > 0) {
              const known = new Set(get().legacy.map((m) => m.seq));
              const fresh = raw.messages.filter((m) => !known.has(m.seq));
              if (fresh.length > 0) set((s) => ({ legacy: [...s.legacy, ...fresh] }));
            }
          } catch {
            // 补拉失败保持已订阅态——后续 appended 仍会到达
          }
        })();
      }
      prevOnline = online;
    });
  };

  return {
    phase: 'resolving',
    errorText: null,
    task: null,
    target: null,
    wire2: false,
    frames: [],
    legacy: [],
    mirrorRows: [],
    hasMore: false,
    loadingEarlier: false,
    live: false,
    hubOnline: true,
    liveError: null,
    pendingSteers: [],

    open(task) {
      // 关上一个（退订 + 清监听）再定位新任务
      const prev = get().target;
      if (prev) {
        const seg = prev.groupId !== null ? { groupId: prev.groupId } : {};
        void ipc.hub
          .viewUnsubscribe({ targetNodeId: prev.targetNodeId, sessionId: prev.sessionId, ...seg })
          .then(() => undefined, () => undefined);
      }
      teardownListeners();
      set({
        phase: 'resolving', errorText: null, task, target: null, wire2: false,
        frames: [], legacy: [], mirrorRows: [], hasMore: false, loadingEarlier: false,
        live: false, liveError: null, pendingSteers: [],
      });
      const routingGroupId = task.routing.mode !== 'local' ? task.routing.groupId : null;
      return (async () => {
        try {
          // ① 账本行反查（delegationId → targetNodeId / workspaceName）
          const { tasks } = await ipc.hub.taskList(routingGroupId !== null ? { groupId: routingGroupId } : undefined);
          const record = tasks.find((t) => t.taskId === task.delegationId);
          if (!record) { set({ phase: 'miss' }); return; }
          const groupId = record.groupId ?? routingGroupId;
          const seg = groupId !== null ? { groupId } : {};

          // ② 会话定位：delegationId 精确匹配优先（§5）；全缺 → 标题兜底（存量）
          const res = await ipc.hub.viewSessions({ targetNodeId: record.targetNodeId, workspaceName: record.workspaceName, limit: VIEW_PAGE_SIZE, ...seg });
          const byDelegation = res.sessions.filter((s) => s.delegationId === task.delegationId);
          const pool = byDelegation.length > 0 ? byDelegation : res.sessions.filter((s) => s.title === task.title);
          const session = pool.sort((a, b) => b.lastSeq - a.lastSeq)[0];
          if (!session) { set({ phase: 'miss' }); return; }

          // ③ 尾窗帧页（wire:2 声明；旧 worker 回旧形态自动降级）
          // fromSeq=0（终审 C3a）：帧页语义=最新 limit 帧尾窗——fromSeq>0 是
          // loadEarlier 方向，会把含流式尾帧在内的最新帧排除在初页外
          const raw = await ipc.hub.viewMessages({
            targetNodeId: record.targetNodeId, sessionId: session.sessionId, workspaceName: record.workspaceName,
            fromSeq: 0, limit: VIEW_PAGE_SIZE, ...seg, wire: 2,
          });

          let nodeName: string | null = null;
          try {
            const nodes = await ipc.hub.getNodes();
            nodeName = nodes.find((n) => n.nodeId === record.targetNodeId)?.nodeName ?? null;
          } catch { /* 展示面——降级短 id */ }

          const target: RemoteSessionTarget = {
            targetNodeId: record.targetNodeId,
            workspaceName: record.workspaceName,
            groupId,
            runNo: record.runNo ?? 1,
            nodeName: nodeName ?? shortNodeId(record.targetNodeId),
            sessionId: session.sessionId,
          };
          if ('frames' in raw) {
            set({ phase: 'ready', target, frames: raw.frames, hasMore: raw.hasMore });
          } else {
            set({ phase: 'ready', target, legacy: raw.messages, hasMore: raw.hasMore });
          }
          refetchMirror();

          // ④ 订阅协商：回显 wire:2 → 帧路径；否则 legacy 降级（§6）
          try {
            const sub = await ipc.hub.viewSubscribe({ targetNodeId: target.targetNodeId, sessionId: target.sessionId, ...seg, wire: 2 });
            const wire2 = sub.wire === 2;
            set({ wire2, live: true, liveError: null });
            if (!wire2 && 'frames' in raw) {
              // worker 帧页可用但 tail 不帧化（旧 hub）——降级一致性：按帧转行渲染
              // wire2=false 时视图读 legacy；此处不回拉，由 appended events 增量补充
            }
          } catch (err) {
            set({ liveError: humanizeViewError(err) });
          }
          wireListeners();
        } catch (err) {
          set({ phase: 'error', errorText: humanizeViewError(err) });
        }
      })();
    },

    close() {
      const t = get().target;
      if (t) {
        const seg = t.groupId !== null ? { groupId: t.groupId } : {};
        void ipc.hub
          .viewUnsubscribe({ targetNodeId: t.targetNodeId, sessionId: t.sessionId, ...seg })
          .then(() => undefined, () => undefined);
      }
      teardownListeners();
      set({
        phase: 'resolving', errorText: null, task: null, target: null, wire2: false,
        frames: [], legacy: [], mirrorRows: [], hasMore: false, loadingEarlier: false,
        live: false, liveError: null, pendingSteers: [],
      });
    },

    loadEarlier() {
      const t = get().target;
      if (!t || get().loadingEarlier || !get().hasMore) return;
      const s = get();
      const firstSeq = s.wire2 && s.frames.length > 0
        ? s.frames[0]!.seq
        : s.legacy.length > 0 ? s.legacy[0]!.seq : 0;
      if (firstSeq <= 0) return;
      const seg = t.groupId !== null ? { groupId: t.groupId } : {};
      set({ loadingEarlier: true });
      void ipc.hub
        .viewMessages({
          targetNodeId: t.targetNodeId, sessionId: t.sessionId, workspaceName: t.workspaceName,
          fromSeq: firstSeq, limit: VIEW_PAGE_SIZE, ...seg, wire: 2,
        })
        .then((raw) => {
          if ('frames' in raw) {
            set((st) => ({ frames: upsertFrames(raw.frames, st.frames), hasMore: raw.hasMore }));
          } else {
            const known = new Set(get().legacy.map((m) => m.seq));
            const fresh = raw.messages.filter((m) => !known.has(m.seq));
            set((st) => ({ legacy: [...fresh, ...st.legacy], hasMore: raw.hasMore }));
          }
          set({ loadingEarlier: false });
        })
        .catch(() => set({ loadingEarlier: false }));
    },

    async sendSteer(text) {
      const task = get().task;
      const trimmed = text.trim();
      if (!task || trimmed === '') return;
      const id = crypto.randomUUID();
      set((s) => ({ pendingSteers: [...s.pendingSteers, { id, text: trimmed, state: 'sending' }] }));
      try {
        await ipc.task.steer(task.id, trimmed);
        set((s) => ({
          pendingSteers: s.pendingSteers.map((p) => (p.id === id ? { ...p, state: 'sent' as const } : p)),
        }));
      } catch (err) {
        set((s) => ({
          pendingSteers: s.pendingSteers.map((p) => (p.id === id
            ? { ...p, state: 'failed' as const, error: err instanceof Error ? err.message : String(err) }
            : p)),
        }));
      }
    },

    async retrySteer(id) {
      const p = get().pendingSteers.find((x) => x.id === id);
      const task = get().task;
      if (!p || !task) return;
      set((s) => ({ pendingSteers: s.pendingSteers.map((x) => (x.id === id ? { ...x, state: 'sending' as const, error: undefined } : x)) }));
      await ipc.task
        .steer(task.id, p.text)
        .then(() => {
          set((s) => ({ pendingSteers: s.pendingSteers.map((x) => (x.id === id ? { ...x, state: 'sent' as const } : x)) }));
        })
        .catch((err: unknown) => {
          set((s) => ({
            pendingSteers: s.pendingSteers.map((x) => (x.id === id
              ? { ...x, state: 'failed' as const, error: err instanceof Error ? err.message : String(err) }
              : x)),
          }));
        });
    },

    dropSteer(id) {
      set((s) => ({ pendingSteers: s.pendingSteers.filter((p) => p.id !== id) }));
    },
  };
});
