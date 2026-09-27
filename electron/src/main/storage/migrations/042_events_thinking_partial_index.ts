// electron/src/main/storage/migrations/042_events_thinking_partial_index.ts
//
// Migration 042：message_events thinking 增量部分索引（2026-09-25 历史消息
// thinking 异步补全的查询支撑）。
//
// 背景：getMessages 事件裁剪（im/events-pruning.ts）对更早/巨型消息只回
// 结构事件，thinking 折叠不可见——体验不一致。补全方案让主进程标出
// 「库内确有 thinking_delta 但未回传」的消息（thinkingPendingIds），由
// renderer 视口触发异步补拉全量事件。本索引让 pending 判定
// （WHERE event_type='thinking_delta' AND message_id IN (...)）成为纯索引
// 探测，不触碰正文/工具等其余行。
//
// down 为真 DROP INDEX（模块内供测试直调；迁移数组只接 .up）。

export interface Migration042 {
  version: number;
  up: string;
  down: string;
}

export const migration042: Migration042 = {
  version: 42,
  up: `
    -- thinking 增量部分索引（thinkingPendingIds 判定 + fetchMessageEvents 补拉专用）
    CREATE INDEX IF NOT EXISTS idx_events_thinking
      ON message_events(message_id, seq)
      WHERE event_type = 'thinking_delta';
  `.trim(),
  down: `
    DROP INDEX IF EXISTS idx_events_thinking;
  `.trim(),
};
