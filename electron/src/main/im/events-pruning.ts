// electron/src/main/im/events-pruning.ts
//
// session:getMessages / session:loadOlder 的事件裁剪（2026-09-25 工作空间切换
// 卡顿修复——真机剖析定位：全量 eventsByMessage 的 N+1 查询 + 逐行 JSON.parse +
// 全量 IPC clone 令主进程事件循环阻塞 1-3s，所有 IPC 停摆）。
//
// 裁剪规则（契约两端同改，回归锁 tests/im/events-pruning.test.ts）：
//   1. 最近 fullRecentCount（缺省 30）条消息 → 全量事件（流式候选 + 即时上下文）
//   2. 最近窗口内单消息事件数 > perMessageCap（缺省 2000）→ 降级压缩快照
//      （防病理巨型消息：实测重会话单条 1.5 万事件，K 窗口按条数圈不住事件量）
//   3. 其余消息 → 压缩快照（C 方案，2026-09-25 显示一致性根治）：终态写时把
//      事件流压缩（连续 thinking/text delta 游程合并、结构事件保留，交错顺序
//      保真）落 message_compact_events——thinking/正文/工具卡全量在场，正文
//      无需 body 回退、thinking 无需异步补拉；缺失快照就地回填（分片让出
//      事件循环，首访一次付出永久受益；boot 另有后台全量回填）
//   4. 零事件消息省略 key（renderer 静态气泡渲染 body）
//
// 压缩事件直接喂 renderer 既有 aggregateEvents——聚合等价性由
// tests/storage/event-compaction.test.ts 契约锁（全量 ≡ 压缩 逐字段相等）。
//
// 依赖 041 部分索引 idx_events_structural（结构事件查询不触碰增量行）。

import type { MessageRow } from '../storage/messages/repo';
import type { MessageEventRow } from '../storage/messages/events-repo';
import {
  listEventsForMessages,
  countEventsByMessage,
} from '../storage/messages/events-repo';
import { backfillCompactSnapshots } from '../storage/messages/event-compaction';
import { projectEventsForWire } from '../storage/messages/event-projection';

/** 最近窗口：最近 N 条消息携带全量事件（覆盖视口 + 流式候选） */
export const FULL_EVENTS_RECENT_MESSAGES = 30;

/** 单消息全量事件上限。超过则该消息走压缩快照路径。 */
export const FULL_EVENTS_PER_MESSAGE_CAP = 2000;

/** buildEventsByMessage 可选项（测试注入小值圈定分支；生产用缺省） */
export interface PruningOpts {
  /** 最近 N 条消息拿全量事件；0 = 全部走压缩快照（loadOlder 翻页语义） */
  fullRecentCount?: number;
  /** 单消息全量事件上限（事件数 > cap 走压缩快照） */
  perMessageCap?: number;
}

/** 回填分片大小：每片之间 setImmediate 让出主进程事件循环（首访不冻结） */
const BACKFILL_CHUNK = 50;

const yieldToEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * messages（须按时间升序，listMessagesBySession / listOlderMessages 已保证）
 * → 裁剪后的 eventsByMessage。查询批量 IN（count / 全量 / 快照），消除逐消息
 * N+1；全量路径走索引（idx_events_msg_seq），快照路径走主键。
 * async：降级集合的快照回填按片让出事件循环。
 */
export async function buildEventsByMessage(
  messages: MessageRow[],
  opts: PruningOpts = {},
): Promise<Record<string, MessageEventRow[]>> {
  if (messages.length === 0) return {};
  const fullRecentCount = opts.fullRecentCount ?? FULL_EVENTS_RECENT_MESSAGES;
  const perMessageCap = opts.perMessageCap ?? FULL_EVENTS_PER_MESSAGE_CAP;

  // 最近窗口（数组末尾 N 条）；0 表示无全量窗口（loadOlder 翻页）
  const recentStart = fullRecentCount <= 0 ? messages.length : Math.max(0, messages.length - fullRecentCount);
  const recentIds = messages.slice(recentStart).map((m) => m.id);
  const olderIds = messages.slice(0, recentStart).map((m) => m.id);

  // 流式消息一律全量（2026-09-26 任务框丢失 P0）：压缩快照只对终态消息成立——
  // 流中回填会把视图截断在写入时刻（工具卡在后段，全部丢失），且实时推送本来
  // 就把这些事件逐条送过 IPC，全量直供不增加数量级成本。终态化由 finalize
  // 钩子补写完整快照（writeCompactSnapshot upsert 覆盖）。
  const streamingIds = new Set(messages.filter((m) => m.status === 'streaming').map((m) => m.id));

  // 巨型消息判定（只扫索引计数；流式除外）；超限者并入压缩快照集合
  const counts = countEventsByMessage(recentIds);
  const giantIds = new Set(
    recentIds.filter((id) => !streamingIds.has(id) && (counts.get(id) ?? 0) > perMessageCap),
  );
  const fullIds = [
    ...recentIds.filter((id) => !giantIds.has(id)),
    ...olderIds.filter((id) => streamingIds.has(id)),
  ];
  const degradedIds = [
    ...olderIds.filter((id) => !streamingIds.has(id)),
    ...recentIds.filter((id) => giantIds.has(id)),
  ];

  const fullEvents = listEventsForMessages(fullIds);

  const eventsByMessage: Record<string, MessageEventRow[]> = {};
  for (const [messageId, events] of fullEvents) {
    eventsByMessage[messageId] = projectEventsForWire(events);
  }

  // 降级集合分片回填压缩快照（缺失才读事件落库；已有走主键直读）
  for (let i = 0; i < degradedIds.length; i += BACKFILL_CHUNK) {
    const chunk = degradedIds.slice(i, i + BACKFILL_CHUNK);
    const compacted = backfillCompactSnapshots(chunk);
    for (const [messageId, events] of compacted) {
      // 零事件消息省略 key——renderer 对缺失 key 走静态 body 气泡
      if (events.length === 0) continue;
      eventsByMessage[messageId] = projectEventsForWire(events);
    }
    // 首访重会话（千级降级消息 × 全量事件回填）时按片让出——主进程不冻结
    if (i + BACKFILL_CHUNK < degradedIds.length) await yieldToEventLoop();
  }
  return eventsByMessage;
}
