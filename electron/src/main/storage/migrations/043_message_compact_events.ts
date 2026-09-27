// electron/src/main/storage/migrations/043_message_compact_events.ts
//
// Migration 043：message_compact_events 表（2026-09-25 历史消息显示一致性
// C 方案——写时压缩快照）。
//
// 背景：getMessages 事件裁剪令更早/巨型消息只回结构事件——正文整块退到
// 末尾（丢失与工具卡的交错顺序）、thinking 需异步补拉（曾引出竞态 P0）。
// 根治：消息终态时把事件流「压缩」落快照——连续 thinking_delta/text_delta
// 游程合并为单条（seq/id 锚定游程首行），结构事件原样保留。压缩事件直接
// 喂 renderer 既有 aggregateEvents（聚合器单一真相源），交错顺序天然保真。
// 重会话实测：2850 事件的消息压缩后约 35 条。
//
// down 为真 DROP TABLE（模块内供测试直调；迁移数组只接 .up）。

export interface Migration043 {
  version: number;
  up: string;
  down: string;
}

export const migration043: Migration043 = {
  version: 43,
  up: `
    CREATE TABLE IF NOT EXISTS message_compact_events (
      message_id TEXT PRIMARY KEY,
      events_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `.trim(),
  down: `
    DROP TABLE IF EXISTS message_compact_events;
  `.trim(),
};
