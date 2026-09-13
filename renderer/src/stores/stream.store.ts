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
   */
  applyEventBatch: (batch: MessageEventRow[]) => void;
  /**
   * 重启场景：从 IPC im.getMessages 拉到的 events 初始化指定 messageId 的 StreamState。
   * 与实时路径走同一个 aggregateEvents，保证重启后聚合一致。
   */
  hydrateFromEvents: (messageId: string, events: MessageEventRow[]) => void;
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
    for (const e of batch) {
      const list = eventLogByMessage.get(e.messageId) ?? [];
      // 去重按 seq（桶内唯一、由 DB 计数器分配）而非 id——流式事件与重启 hydrate
      // 的 id 生成时机不同，按 id 去重在 id 缺失/占位时会误杀后续批次（P0-5）
      if (list.some((x) => x.seq === e.seq)) continue;
      list.push(e);
      list.sort((a, b) => a.seq - b.seq);
      eventLogByMessage.set(e.messageId, list);
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
        });
      }
      return {
        streams: newStreams,
        // 一次性标志只置不清（netBlocked=false 时不写入，保持现值）
        ...(netBlocked ? { netBlockedSeen: true } : {}),
      };
    });
  },

  hydrateFromEvents: (messageId, events) => {
    // 空 events 防御（P0-4）：零事件消息（用户消息）不创建 streams 条目——
    // aggregateEvents([]) 的默认 status 是 'streaming'，写入会让 MessageBubble
    // 把静态消息渲染成空的"流式中"气泡，消息文本不可见。
    if (events.length === 0) return;
    // 用传入的 events 覆盖该 messageId 的 eventLog（重启场景：IPC 拉的是权威全量）
    eventLogByMessage.set(messageId, [...events].sort((a, b) => a.seq - b.seq));
    set((state) => {
      const newStreams = new Map(state.streams);
      const aggregated = aggregateEvents(eventLogByMessage.get(messageId) ?? []);
      newStreams.set(messageId, {
        ...aggregated,
        messageId,
        startedAt: events[0]?.createdAt ?? Date.now(),
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
