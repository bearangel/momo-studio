// renderer/src/stores/stream.store.ts
//
// A 子系统重写：基于 message_events 事件流聚合 StreamState。
//
// 数据来源（两条路径走同一份 events + 同一个 aggregateEvents 函数，UI 必然一致）：
//   - 实时：ipc.session.onMessageEventBatch 推送（主进程 MessageEventBuffer 每 50ms flush）
//   - 重启：ipc.session.getMessages 返回的 eventsByMessage（selectSession 时一次性拉取）
//
// 核心不变量：renderer 实时显示与重启后显示完全一致——因为两路都用 aggregateEvents
// 处理同一份 MessageEventRow 数组。
//
// v2.0 A 子系统相对 v1.4 的根本变化：
//   - streams Map 改为 keyed by messageId（不再用 streamSessionId）
//   - 删除 ipc.agent.onStream 订阅（旧 StreamChunk 通道废弃）
//   - 删除 init() / clearCompleted()（聚合由 events 驱动，不再需要手动清理）
//   - StreamState extends AggregatedStream（共用聚合输出类型）
import { create } from 'zustand';
import type { MessageEventRow } from '../ipc/types';
import { aggregateEvents, type AggregatedStream, type StreamSegment } from '../lib/stream-aggregator';

export type { StreamSegment };

/**
 * v2.4.x net-off 拦截检测双条件（生产者：主进程 resolveShellSpawn 生成 tag、
 * shell-tools.ts 把 `sandbox: <tag>` 行紧跟 exit_code 写进 bash 结果文本）：
 * ① tag 为 net-off（bwrap/seatbelt——tag 在场=网络态权威）
 * ② 命中网络拒绝签名任一（监听 EPERM / connect·connection 近距 EPERM / DNS 解析失败 / curl 6·7）。
 * 仅 tag 不触发（未碰网络的命令不打扰）；仅签名不触发（非沙箱所致的网络错误）。
 */
const SANDBOX_NET_OFF_TAG = /sandbox: (?:seatbelt|bwrap)\/net-off/;
const NET_BLOCKED_SIGNATURES: readonly RegExp[] = [
  /listen EPERM/i,
  /(?:connect|connection)[^\n]{0,60}EPERM/i,
  /Could not resolve host/i,
  /cannot resolve [^\n]{0,60}Unknown host/i,
  /curl: \((?:6|7)\)/,
  // macOS seatbelt 真实形态（2026-09-13 真机实证，与主进程 network-trust.ts 同源成对修改）
  /(?:bind|connect|sendto|socket)[^\n]{0,60}(?:Operation not permitted|Permission denied|EPERM|unexpected error)/i,
  /getaddrinfo[^\n]{0,20}(?:EAI_AGAIN|ENOTFOUND|EPERM)/i,
];

function detectNetBlocked(resultText: string): boolean {
  return (
    SANDBOX_NET_OFF_TAG.test(resultText) &&
    NET_BLOCKED_SIGNATURES.some((re) => re.test(resultText))
  );
}

/**
 * 工具链写拦截固定子串（spec 2026-10-01 §7/§8）。与 electron 侧 WRITE_BLOCKED_HINT
 * （sandbox-write-hint.ts，Task 4 逐字锁）同源——跨进程无共享模块，renderer 硬编码
 * 同一子串，两端测试各自逐字锁死。主进程 detectHomeWriteBlocked 命中时把完整提示段
 * 追加到 bash 结果尾部，renderer 据此置引导卡标志。
 */
/**
 * A 子系统 StreamState。
 *
 * extends AggregatedStream（A5 共用聚合函数输出）+ 补充会话上下文字段。
 *
 * A5 的 AggregatedStream 缺 3 个会话上下文字段（streamSessionId / botUserId /
 * parentStreamSessionId）——这些不在 events 里（events 只描述内容），需要从 message
 * 推断。本 task 在 StreamState 内补齐为可选字段，消费方按需从 message 关联。
 */
export interface StreamState extends AggregatedStream {
  /** 关联 SQLite messages.id（streams Map 的 key，A 子系统改用 messageId 索引） */
  messageId: string;
  /** 第一条 event 的 createdAt（用于消息混合排序） */
  startedAt: number;
  /** A5 缺失字段补齐：从 message.streamSessionId 推断 */
  streamSessionId?: string;
  /** A5 缺失字段补齐：从 message.sender 推断 */
  botUserId?: string;
  /** A5 缺失字段补齐：从 message.parentStreamSessionId 推断 */
  parentStreamSessionId?: string;
  /**
   * D8（2026-10-31 dispatch 卡透明化）：该流最后一个实时事件的应用时刻。
   * 仅 applyEventBatch（实时推送）刷新——历史回放（hydrateFromEvents）与用户
   * 触发展开（expand*）只保留既有值、不算活动；流终态后冻结。
   * dispatch 卡/在途面板的「活动 Ns 前」停滞指示数据源。
   */
  lastEventAt?: number;
}

interface StreamStoreState {
  /** messageId → 聚合状态（A 子系统：keyed by messageId，不再用 streamSessionId） */
  streams: Map<string, StreamState>;
  /**
   * v2.4.x net-off 拦截一次性标志：实时批次检测到「沙箱断网导致 bash 网络失败」即置位。
   * 每 app 运行至多置一次、不自动复位（reset 也不清）——卡由用户 dismiss 或重启自然消失。
   */
  netBlockedSeen: boolean;
  /**
   * 接收主进程 MessageEventBuffer flush 推送的批量 events。
   * 累积到内部 eventLog 后重新聚合所有受影响的 messageId。
   *（v2.5 工具链子串扫描链已于 2026-10-03 随事件驱动授权卡废除——写拦截信号
   *  走 sandbox:writeBlocked 推送 + write-grant.store，见 spec §5.4）
   */
  applyEventBatch: (batch: MessageEventRow[]) => void;
  /**
   * 重启场景：从 IPC im.getMessages 拉到的 events 初始化指定 messageId 的 StreamState。
   * 与实时路径走同一个 aggregateEvents，保证重启后聚合一致。
   *
   * fallbackBody（事件裁剪回退，2026-09-25）：getMessages 对更早/巨型消息只回
   * 结构事件（无 text_delta）——终态且聚合正文为空时用 message.body 回填，
   * 缺省（旧调用方）行为不变。
   */
  hydrateFromEvents: (messageId: string, events: MessageEventRow[], fallbackBody?: string) => void;
  /**
   * thinking 全量展开（2026-10-14 P0-2，wire 截断配套）：用 getMessageThinking
   * 拉回的全量游程（seq 与截断版同源）替换 eventLog 里的截断 thinking 与
   * marker，重新聚合——截断标志自然消失，交错顺序（seq 序）保真。
   * fallbackBody 语义同 hydrateFromEvents（零 text_delta 终态消息的正文回退）。
   */
  expandThinking: (
    messageId: string,
    runs: Array<{ seq: number; delta: string }>,
    fallbackBody?: string,
  ) => void;
  /**
   * 工具结果全量展开（wire 截断第二刀）：用 getMessageToolResults 拉回的全量
   * （seq 与截断版同源）按 seq 替换 eventLog 里的截断 tool_call_result——新事件
   * 不带 truncated 键，重聚合后标志自然消失；success 等兄弟 payload 字段从
   * 原事件保留。零 text_delta 终态消息的正文回退从上次聚合结果继承（防洗白）。
   */
  expandToolResults: (
    messageId: string,
    results: Array<{ seq: number; callId: string; result: string }>,
  ) => void;
  /**
   * v2.4.x 网络信任卡路径置位入口（spec §6 防双弹）：ask 策略下网络失败由信任卡
   * 负责，本标志由信任卡出现时一并置位——与实时批次检测共用同一一次性语义。
   */
  markNetBlockedSeen: () => void;
  /** 清空所有 streams + 累积 events（切换 workspace / 登出时调用） */
  reset: () => void;
}

/**
 * 模块级累积 events 缓冲（按 messageId 分桶）。
 *
 * 放在模块级而非 store state：events 缓冲本身不需要触发 React 重渲染（只有聚合后的
 * streams Map 变化才需要），避免每次 set 都深拷贝大数组。
 */
const eventLogByMessage = new Map<string, MessageEventRow[]>();

export const useStreamStore = create<StreamStoreState>((set) => ({
  streams: new Map(),
  netBlockedSeen: false,

  applyEventBatch: (batch) => {
    if (batch.length === 0) return;
    // net-off 检测只看实时批次；hydrateFromEvents 回放历史不触发（「重启自然消失」语义）
    const netBlocked = batch.some(
      (e) =>
        e.eventType === 'tool_call_result' &&
        typeof e.payload.result === 'string' &&
        detectNetBlocked(e.payload.result),
    );
    // 累积到 eventLog（按 messageId 分桶 + 去重 + 按 seq 升序）
    // D14（验收报告）：逐事件全量 sort → 批量去重 append 后单次 sort——
    // 大回合桶（数万事件）下循环内排序是 O(N·batch·logN) 重活（停止路径阻塞的
    // 构成部分）；seq 已由批内有序 + 桶内单调，单次排序足够
    const touched = new Map<string, MessageEventRow[]>();
    for (const e of batch) {
      const list = eventLogByMessage.get(e.messageId) ?? [];
      // 去重按 seq（桶内唯一、由 DB 计数器分配）而非 id——流式事件与重启 hydrate
      // 的 id 生成时机不同，按 id 去重在 id 缺失/占位时会误杀后续批次（P0-5）
      if (list.some((x) => x.seq === e.seq)) continue;
      list.push(e);
      touched.set(e.messageId, list);
      eventLogByMessage.set(e.messageId, list);
    }
    for (const list of touched.values()) {
      list.sort((a, b) => a.seq - b.seq);
    }
    // 重新聚合所有受影响的 messageId
    set((state) => {
      const newStreams = new Map(state.streams);
      const affectedIds = new Set(batch.map((e) => e.messageId));
      for (const msgId of affectedIds) {
        const events = eventLogByMessage.get(msgId) ?? [];
        const aggregated = aggregateEvents(events);
        newStreams.set(msgId, {
          ...aggregated,
          messageId: msgId,
          startedAt: events[0]?.createdAt ?? Date.now(),
          // D8 最后活动：实时批即活动；终态后冻结（保留此前值）
          lastEventAt:
            aggregated.status === 'streaming'
              ? Date.now()
              : state.streams.get(msgId)?.lastEventAt,
        });
      }
      return {
        streams: newStreams,
        // 一次性标志只置不清（netBlocked=false 时不写入，保持现值）
        ...(netBlocked ? { netBlockedSeen: true } : {}),
      };
    });
  },

  hydrateFromEvents: (messageId, events, fallbackBody) => {
    // 空 events 防御（P0-4）：零事件消息（用户消息）不创建 streams 条目——
    // aggregateEvents([]) 的默认 status 是 'streaming'，写入会让 MessageBubble
    // 把静态消息渲染成空的"流式中"气泡，消息文本不可见。
    if (events.length === 0) return;
    // 按 seq 归并而非整体覆盖（2026-09-26 任务框丢失 P0）：同 seq 以 hydrate
    // （DB 权威）为准；已积累的更大 seq 实时事件保留——截断载荷（如流中快照）
    // 不得抹掉实时视图
    const bySeq = new Map((eventLogByMessage.get(messageId) ?? []).map((e) => [e.seq, e]));
    for (const e of events) bySeq.set(e.seq, e);
    const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    eventLogByMessage.set(messageId, merged);
    set((state) => {
      const newStreams = new Map(state.streams);
      const aggregated = aggregateEvents(eventLogByMessage.get(messageId) ?? []);
      // 事件裁剪回退（2026-09-25）：getMessages 对更早/巨型消息只回结构事件
      //（无 text_delta）——终态消息正文以 message.body 为单一真相源，聚合
      // 正文为空且给了 fallbackBody 时回填，保证带工具卡的历史消息文本可见；
      // segments 末尾补 text 段（AgentStreamBubble 按 segments 线性渲染）。
      // 仅终态生效：流式消息正文以 delta 为准，回退会盖掉进行中的空窗。
      const useFallback =
        fallbackBody !== undefined &&
        fallbackBody.trim() !== '' &&
        aggregated.status !== 'streaming' &&
        aggregated.text === '';
      const text = useFallback ? fallbackBody : aggregated.text;
      const segments = useFallback
        ? [...aggregated.segments, { kind: 'text' as const, text: fallbackBody }]
        : aggregated.segments;
      newStreams.set(messageId, {
        ...aggregated,
        text,
        segments,
        messageId,
        startedAt: merged[0]?.createdAt ?? Date.now(),
        // D8：历史回放不算实时活动——保留实时路径积累的值，不刷新
        lastEventAt: state.streams.get(messageId)?.lastEventAt,
      });
      return { streams: newStreams };
    });
  },

  expandThinking: (messageId, runs, fallbackBody) => {
    const log = eventLogByMessage.get(messageId);
    if (!log || runs.length === 0) return;
    // seq → createdAt 保留映射：全量游程不携带 createdAt，沿用截断版的对应值
    const createdAtBySeq = new Map(log.map((e) => [e.seq, e.createdAt]));
    const lastCreatedAt = log[log.length - 1]?.createdAt ?? Date.now();
    // 剔除截断版 thinking 与 marker，换入全量游程，按 seq 归并（交错顺序保真）
    const kept = log.filter(
      (e) => e.eventType !== 'thinking_delta' && e.eventType !== 'thinking_truncated',
    );
    const full = runs.map((r) => ({
      id: `expand-${messageId}-${r.seq}`,
      messageId,
      seq: r.seq,
      eventType: 'thinking_delta' as const,
      payload: { delta: r.delta },
      createdAt: createdAtBySeq.get(r.seq) ?? lastCreatedAt,
    }));
    const merged = [...kept, ...full].sort((a, b) => a.seq - b.seq);
    eventLogByMessage.set(messageId, merged);
    set((state) => {
      const newStreams = new Map(state.streams);
      const aggregated = aggregateEvents(merged);
      // 正文回退语义与 hydrateFromEvents 一致：零 text_delta 终态消息正文以
      // message.body 为单一真相源，防展开重聚合把静态正文洗掉
      const useFallback =
        fallbackBody !== undefined &&
        fallbackBody.trim() !== '' &&
        aggregated.status !== 'streaming' &&
        aggregated.text === '';
      const text = useFallback ? fallbackBody : aggregated.text;
      const segments = useFallback
        ? [...aggregated.segments, { kind: 'text' as const, text: fallbackBody }]
        : aggregated.segments;
      newStreams.set(messageId, {
        ...aggregated,
        text,
        segments,
        messageId,
        startedAt: merged[0]?.createdAt ?? Date.now(),
        // D8：用户触发展开不算 agent 活动——保留既有值
        lastEventAt: state.streams.get(messageId)?.lastEventAt,
      });
      return { streams: newStreams };
    });
  },

  expandToolResults: (messageId, results) => {
    const log = eventLogByMessage.get(messageId);
    if (!log || results.length === 0) return;
    // seq → 全量替换事件：payload 从原事件继承兄弟字段（success 等），
    // 剥掉 truncated/fullLength 截断键——重聚合后标志自然消失
    const oldBySeq = new Map(log.map((e) => [e.seq, e]));
    const replaceBySeq = new Map<number, MessageEventRow>();
    for (const r of results) {
      const old = oldBySeq.get(r.seq);
      const { truncated: _t, fullLength: _f, ...rest } = (old?.payload ?? {}) as Record<string, unknown>;
      replaceBySeq.set(r.seq, {
        id: old?.id ?? `expand-${messageId}-${r.seq}`,
        messageId,
        seq: r.seq,
        eventType: 'tool_call_result',
        payload: { ...rest, callId: r.callId, result: r.result },
        createdAt: old?.createdAt ?? (log[log.length - 1]?.createdAt ?? Date.now()),
      });
    }
    const merged = log.map((e) => replaceBySeq.get(e.seq) ?? e);
    eventLogByMessage.set(messageId, merged);
    set((state) => {
      const newStreams = new Map(state.streams);
      const aggregated = aggregateEvents(merged);
      // 零 text_delta 终态消息的正文回退继承上次聚合（expandThinking 的
      // fallbackBody 同款语义，此处无 body props——从 prev stream 继承）
      const prev = state.streams.get(messageId);
      const keepFallback =
        aggregated.status !== 'streaming' && aggregated.text === '' && prev !== undefined && prev.text !== '';
      const text = keepFallback ? prev.text : aggregated.text;
      const segments = keepFallback
        ? [...aggregated.segments, { kind: 'text' as const, text: prev.text }]
        : aggregated.segments;
      newStreams.set(messageId, {
        ...aggregated,
        text,
        segments,
        messageId,
        startedAt: merged[0]?.createdAt ?? Date.now(),
        // D8：用户触发展开不算 agent 活动——保留既有值
        lastEventAt: state.streams.get(messageId)?.lastEventAt,
      });
      return { streams: newStreams };
    });
  },

  reset: () => {
    eventLogByMessage.clear();
    // 刻意不清 netBlockedSeen：一次性标志每 app 运行至多置一次，workspace 切换不重置
    set({ streams: new Map() });
  },

  markNetBlockedSeen: () => {
    // 一次性标志只置不清（与 applyEventBatch 检测路径同一语义）
    set((state) => (state.netBlockedSeen ? {} : { netBlockedSeen: true }));
  },

}));
