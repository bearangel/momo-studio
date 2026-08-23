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
import { aggregateEvents, type AggregatedStream } from '../lib/stream-aggregator';

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
   * 接收主进程 MessageEventBuffer flush 推送的批量 events。
   * 累积到内部 eventLog 后重新聚合所有受影响的 messageId。
   */
  applyEventBatch: (batch: MessageEventRow[]) => void;
  /**
   * 重启场景：从 IPC im.getMessages 拉到的 events 初始化指定 messageId 的 StreamState。
   * 与实时路径走同一个 aggregateEvents，保证重启后聚合一致。
   */
  hydrateFromEvents: (messageId: string, events: MessageEventRow[]) => void;
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

  applyEventBatch: (batch) => {
    if (batch.length === 0) return;
    // 累积到 eventLog（按 messageId 分桶 + 按 id 去重 + 按 seq 升序）
    for (const e of batch) {
      const list = eventLogByMessage.get(e.messageId) ?? [];
      // 去重：启动时 hydrateFromEvents 与首批实时推送可能重叠
      if (list.some((x) => x.id === e.id)) continue;
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
      return { streams: newStreams };
    });
  },

  hydrateFromEvents: (messageId, events) => {
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
    set({ streams: new Map() });
  },
}));
