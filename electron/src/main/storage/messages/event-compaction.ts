// electron/src/main/storage/messages/event-compaction.ts
//
// 事件压缩快照（2026-09-25 历史消息显示一致性 C 方案）。
//
// 问题：getMessages 事件裁剪对更早/巨型消息只回结构事件——正文整块退到
// 末尾（丢失与工具卡的交错顺序）、thinking 不可见（异步补拉方案又引出
// 工作空间切换竞态 P0，已随本方案整体退役）。
//
// 方案：消息终态时把事件流压缩后落 message_compact_events 表——连续
// thinking_delta / text_delta **游程**合并为单条事件（id/seq/createdAt 锚定
// 游程首行，delta 为拼接全文），结构事件原样保留。压缩事件直接喂 renderer
// 既有 aggregateEvents：聚合器单一真相源（无第二套聚合语义可漂移），交错
// 顺序天然保真。实测重会话单条 2850 事件压缩后约 35 条。
//
// 等价性由契约测试锁定（tests/storage/event-compaction.test.ts）：
// 对同一事件集，aggregateEvents(全量) ≡ aggregateEvents(压缩) 逐字段相等。
//
// 历史数据：无快照的旧消息在 getMessages 命中时惰性回填（分批压缩落库，
// 一次付出永久受益）；boot 后另有后台全量回填兜底。

import { getDb } from '../db';
import { logger } from '../../logger';
import { listEventsByMessage, listEventsForMessages, type MessageEventRow } from './events-repo';

const DELTA_TYPES: ReadonlySet<MessageEventRow['eventType']> = new Set(['thinking_delta', 'text_delta']);

/**
 * 压缩事件流：合并连续同类 delta 游程，结构事件原样保留。
 * 纯函数、保序——输入按 seq 升序时输出保持升序（seq 取游程首行）。
 */
export function compactEventDeltas(events: MessageEventRow[]): MessageEventRow[] {
  const out: MessageEventRow[] = [];
  for (const ev of events) {
    // 非字符串 delta 行原样透传（aggregateEvents 对其跳过——coerce 合并会破坏等价性）
    if (!DELTA_TYPES.has(ev.eventType) || typeof ev.payload.delta !== 'string') {
      out.push(ev);
      continue;
    }
    const prev = out[out.length - 1];
    // 仅并入「同类且 delta 为字符串」的前行——非字符串 delta 行是透传行
    //（聚合器跳过它），吸收会把非法载荷变成可渲染文本
    if (prev && prev.eventType === ev.eventType && typeof prev.payload.delta === 'string') {
      // 同类游程延续：delta 拼接，锚点（id/seq/createdAt）保持游程首行
      prev.payload = { delta: `${prev.payload.delta ?? ''}${ev.payload.delta}` };
    } else {
      // 游程起点：浅拷贝后写入（不改动入参事件对象）
      out.push({ ...ev, payload: { delta: ev.payload.delta } });
    }
  }
  return out;
}

/** 幂等 upsert 一条消息的压缩快照 */
export function writeCompactSnapshot(messageId: string): void {
  const compacted = compactEventDeltas(listEventsByMessage(messageId));
  getDb()
    .prepare(
      `INSERT INTO message_compact_events (message_id, events_json, created_at) VALUES (?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET events_json = excluded.events_json, created_at = excluded.created_at`,
    )
    .run(messageId, JSON.stringify(compacted), Date.now());
}

/** 批量读压缩快照（无快照的消息不在返回 Map 中）。走主键，无 payload 膨胀。 */
export function getCompactSnapshots(messageIds: string[]): Map<string, MessageEventRow[]> {
  const out = new Map<string, MessageEventRow[]>();
  if (messageIds.length === 0) return out;
  const db = getDb();
  const stmt = db.prepare(`SELECT message_id, events_json FROM message_compact_events WHERE message_id = ?`);
  for (const id of messageIds) {
    const row = stmt.get(id) as { message_id: string; events_json: string } | undefined;
    if (!row) continue;
    try {
      out.set(row.message_id, JSON.parse(row.events_json) as MessageEventRow[]);
    } catch {
      // 损坏行按无快照处理（上层回填路径自愈重写）
    }
  }
  return out;
}

/**
 * 惰性回填：为无快照/快照陈旧的终态消息批量压缩落库并返回。消费方：getMessages
 * 事件裁剪读路径——首次访问旧会话时一次付出（每消息单次读事件 + 单次写快照），
 * 后续访问直接命中快照。
 *
 * 两条守卫（2026-09-26 流中快照截断 P0）：
 *   - 流式消息一律不回填不返回——流中快照会把视图截断在写入时刻（工具卡在后段
 *     丢失）；终态化由 finalize 钩子 upsert 补写完整版
 *   - 快照 created_at < 消息 updated_at（终态化晚于快照写入）视为陈旧重算——
 *     自愈历史中毒行（finalize 钩子缺失/被杀路径留下的流中快照）
 */
export function backfillCompactSnapshots(messageIds: string[]): Map<string, MessageEventRow[]> {
  // 终态消息按快照新鲜度分流：新鲜（created_at ≥ updated_at）直读复用；
  // 缺失或陈旧（终态化晚于快照写入）统一重算 upsert 覆盖
  const rows =
    messageIds.length === 0
      ? []
      : (getDb()
          .prepare(
            `SELECT m.id,
                    CASE WHEN c.message_id IS NOT NULL AND c.created_at >= m.updated_at
                         THEN 1 ELSE 0 END AS fresh
             FROM messages m
             LEFT JOIN message_compact_events c ON c.message_id = m.id
             WHERE m.id IN (${messageIds.map(() => '?').join(',')})
               AND m.status != 'streaming'`,
          )
          .all(...messageIds) as Array<{ id: string; fresh: 0 | 1 }>);
  const freshIds = rows.filter((r) => r.fresh === 1).map((r) => r.id);
  const existing = getCompactSnapshots(freshIds);
  // 损坏 events_json 行被 getCompactSnapshots 静默丢弃（按无快照处理）——
  // 这些 id 必须并入重算集，否则永不自愈
  const dropped = freshIds.filter((id) => !existing.has(id));
  const recomputeIds = [...rows.filter((r) => r.fresh === 0).map((r) => r.id), ...dropped];
  if (recomputeIds.length === 0) return existing;
  const upsert = getDb().prepare(
    `INSERT INTO message_compact_events (message_id, events_json, created_at) VALUES (?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET events_json = excluded.events_json, created_at = excluded.created_at`,
  );
  const withEvents = listEventsForMessages(recomputeIds);
  for (const id of recomputeIds) {
    // 零事件消息也落空快照——标记「已处理」，后续读路径不再重复回填
    const compacted = compactEventDeltas(withEvents.get(id) ?? []);
    upsert.run(id, JSON.stringify(compacted), Date.now());
    existing.set(id, compacted);
  }
  return existing;
}

/** 后台全量回填防重入标记（boot 只跑一次） */
let backgroundBackfillStarted = false;

/**
 * boot 后台全量回填（C 方案历史数据兜底）：为全部无快照的终态消息补压缩
 * 快照——setImmediate 分片让出事件循环，不阻塞启动与其余 IPC；用户先于
 * 回填完成打开旧会话时，读路径的惰性回填与这里幂等互备（upsert 同值）。
 * 失败静默结束（读路径自愈）；fire-and-forget，调用方不 await。
 */
export function backfillAllCompactSnapshotsInBackground(): void {
  if (backgroundBackfillStarted) return;
  backgroundBackfillStarted = true;
  void (async () => {
    try {
      const rows = getDb()
        .prepare(
          `SELECT m.id FROM messages m
           LEFT JOIN message_compact_events c ON c.message_id = m.id
           WHERE c.message_id IS NULL AND m.status != 'streaming'`,
        )
        .all() as Array<{ id: string }>;
      const upsert = getDb().prepare(
        `INSERT INTO message_compact_events (message_id, events_json, created_at) VALUES (?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET events_json = excluded.events_json, created_at = excluded.created_at`,
      );
      const yieldToEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
      let done = 0;
      for (let i = 0; i < rows.length; i += 50) {
        const chunk = rows.slice(i, i + 50);
        for (const row of chunk) {
          upsert.run(row.id, JSON.stringify(compactEventDeltas(listEventsByMessage(row.id))), Date.now());
          done += 1;
        }
        await yieldToEventLoop();
      }
      if (done > 0) logger.info('压缩快照后台回填完成', { count: done });
    } catch (err) {
      logger.warn('压缩快照后台回填中断（读路径将惰性补齐）', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}
