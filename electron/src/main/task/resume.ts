// electron/src/main/task/resume.ts
//
// v2.6.0 任务断点续跑——启动期清扫与恢复编排。
//
// 本模块 Task 3 只落 sweepStaleStreaming（boot 陈旧流清扫）：messages 表中
// 因 App 崩溃 / 强制 kill 而滞留 status='streaming' 的行 → 'failed' + 中文
// final 事件「进程中断」。app 崩溃路径兜底，正常关机已由 finalizeStreamOnCrash
// 在 child exit 时覆盖；T5 启动期调用。boot 接线点由 Task 5 统一注入，避免
// 两次动 boot 链（裁定 1 的隐含约束）。
//
// 形态严格对齐 stream-relay.finalizeStreamOnCrash：
//   - updateMessageStatus(id, 'failed', aggregateTextDeltas(id))：正文聚合回写
//     （body 单一真相源，与崩溃收尾同契约）
//   - 追加 final 事件 { status: 'failed', error: STALE_STREAM_ERROR }
//   - 行末显式 flush（boot 时序：事件立即落盘，不等下一窗口）
//
// 幂等：单行 update 完即变 failed，二次清扫无命中；非 streaming 行零触碰。
// 错误隔离：每行 try/catch——单行收尾失败不阻断其余行清扫；扫描本身失败
// （DB 未就绪）按 warn 记录返回 0，不阻断 boot。
//
// 后续 Task 5 在本文件追加 detectInterrupted / resumeTask / boot 接线 + IPC。

import { logger } from '../logger';
import { getDb } from '../storage/db';
import { updateMessageStatus } from '../storage/messages/repo';
import { aggregateTextDeltas } from '../storage/messages/events-repo';
import { getEventBuffer } from '../agent/stream-relay';

/**
 * 陈旧 streaming 消息的统一中文错误文案（final 事件 payload.error）。
 * 导出常量供 UI / 恢复链引用——避免文案漂移。
 */
export const STALE_STREAM_ERROR = '进程中断';

/**
 * 清扫 messages 表中滞留 status='streaming' 的行（App 崩溃 / 强制 kill 未
 * 经 finalizeStreamOnCrash 正常收尾的兜底）。每行：聚合 text_delta 写回 body
 * → 标 failed → 追加 final 事件「进程中断」。返回实际清扫行数。
 *
 * 错误隔离：单行收尾失败 log warn 跳过继续；SELECT 失败（DB 未就绪）整体
 * 返回 0 不抛错——调用方是 boot 链，绝不阻断启动。
 */
export function sweepStaleStreaming(): number {
  let staleIds: string[];
  try {
    const rows = getDb()
      .prepare(`SELECT id FROM messages WHERE status = 'streaming'`)
      .all() as Array<{ id: string }>;
    staleIds = rows.map((r) => r.id);
  } catch (err) {
    // DB 未就绪（boot 早于迁移等极端时序）——本次启动跳过清扫，行留待下次；
    // 绝不抛出（调用方是 boot 链）
    logger.warn('陈旧 streaming 消息扫描失败（本次启动跳过清扫）', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  let swept = 0;
  for (const id of staleIds) {
    try {
      // 与 finalizeStreamOnCrash 同契约：正文聚合回写（body 单一真相源）
      updateMessageStatus(id, 'failed', aggregateTextDeltas(id));
      getEventBuffer().append({
        messageId: id,
        eventType: 'final',
        payload: { status: 'failed', error: STALE_STREAM_ERROR },
      });
      swept += 1;
    } catch (err) {
      // 单行失败不阻断其余行（下一行可能属于另一个会话/任务）
      logger.warn('陈旧 streaming 消息收尾失败（继续处理其余行）', {
        messageId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // boot 时序：立即落盘——不等下一 append/50ms 窗口（其后可能长期无写入）
  getEventBuffer().flush();
  return swept;
}