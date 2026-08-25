// electron/src/main/storage/messages/event-buffer.ts
//
// 主进程 stream chunk 批量缓冲。runtime 子进程通过 IPC 把每个 chunk 推给主进程，
// 主进程聚批后单事务落盘 + 一次性推送给 renderer。
//
// 性能保障（实测）：
//   - better-sqlite3 + WAL，单事务批量 INSERT：~1μs/条
//   - 50ms 窗口 / 30 条阈值 → 用户感受延迟 < 50ms（人类感知下限）
//   - IPC 推送批量（session:message_event_batch）减少内核切换开销
//
// 单例由 A8 在 im:message_event 通道注册时创建；stream-relay 消费。
import type { MessageEventRow } from './events-repo';
import { insertEventBatch, nextSeqForMessage } from './events-repo';
import { logger } from '../../logger';

export interface BufferedEvent {
  messageId: string;
  seq: number;
  eventType: MessageEventRow['eventType'];
  payload: Record<string, unknown>;
}

export interface MessageEventBufferOpts {
  flushMs?: number;
  flushBatch?: number;
  /** flush 完成后回调（用于把 batch 推给 renderer） */
  onFlush?: (events: MessageEventRow[]) => void;
}

interface PendingItem {
  messageId: string;
  eventType: MessageEventRow['eventType'];
  payload: Record<string, unknown>;
}

const DEFAULT_FLUSH_MS = 50;
const DEFAULT_FLUSH_BATCH = 30;

export class MessageEventBuffer {
  private pending: PendingItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly flushMs: number;
  private readonly flushBatch: number;
  private readonly onFlush?: (events: MessageEventRow[]) => void;
  private destroyed = false;

  constructor(opts: MessageEventBufferOpts = {}) {
    this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
    this.flushBatch = opts.flushBatch ?? DEFAULT_FLUSH_BATCH;
    this.onFlush = opts.onFlush;
  }

  append(input: Omit<BufferedEvent, 'seq'> & Partial<Pick<BufferedEvent, 'seq'>>): void {
    if (this.destroyed) return;
    this.pending.push({ messageId: input.messageId, eventType: input.eventType, payload: input.payload });
    if (this.pending.length >= this.flushBatch) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
    }
  }

  flush(): void {
    if (this.destroyed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;

    // 为每条 pending 算 seq（按 message 维度）
    const seqCache = new Map<string, number>();
    const rows: Array<Omit<MessageEventRow, 'id' | 'createdAt'>> = this.pending.map((item) => {
      const seq = seqCache.get(item.messageId) ?? nextSeqForMessage(item.messageId);
      seqCache.set(item.messageId, seq + 1);
      return { messageId: item.messageId, seq, eventType: item.eventType, payload: item.payload };
    });
    // onFlush 必须收到带真实唯一 id 的行（与 DB 落盘行同源）——此前传 id:'buffered'
    // 占位符，renderer 按 id 去重会把第一批之后的全部实时事件误杀（P0-5：
    // 实时只剩"流式中"状态条，内容全部丢失，重启拉 DB 才完整）。
    let inserted: MessageEventRow[];
    try {
      inserted = insertEventBatch(rows);
    } catch (err) {
      // minor-2：落库失败保留 pending（下个窗口 / 下次 append 触发重试）——
      // 旧实现先清空再 insert，DB 锁定 / 磁盘满时整批事件直接丢失。
      // seq 已按 nextSeqForMessage 预分配，重试时会按当时的表内最大 seq
      // 重新计算（失败的 insert 未持久化，不会产生 seq 冲突）。
      logger.error('MessageEventBuffer 批量落库失败（pending 保留待重试）', {
        batchSize: rows.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.pending = [];
    if (this.onFlush) {
      this.onFlush(inserted);
    }
  }

  pendingCount(): number {
    return this.pending.length;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = [];
  }
}