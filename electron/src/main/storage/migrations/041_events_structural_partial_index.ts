// electron/src/main/storage/migrations/041_events_structural_partial_index.ts
//
// Migration 041：message_events 结构事件部分索引（2026-09-25 工作空间切换
// 卡顿修复的查询支撑）。
//
// 背景：getMessages 事件裁剪（im/events-pruning.ts）对更早/巨型消息只取
// 结构事件（event_type NOT IN ('text_delta','thinking_delta')）。增量行占
// 重会话事件的绝对多数（实测 45 万事件/29 条消息）——无部分索引时该查询
// 仍需经 idx_events_msg_seq 扫过全部行；部分索引让结构查询只触碰结构行。
//
// down 为真 DROP INDEX（模块内供测试直调；迁移数组只接 .up）。

export interface Migration041 {
  version: number;
  up: string;
  down: string;
}

export const migration041: Migration041 = {
  version: 41,
  up: `
    -- 结构事件部分索引（裁剪查询专用）：只含非增量行
    CREATE INDEX IF NOT EXISTS idx_events_structural
      ON message_events(message_id, seq)
      WHERE event_type NOT IN ('text_delta', 'thinking_delta');
  `.trim(),
  down: `
    DROP INDEX IF EXISTS idx_events_structural;
  `.trim(),
};
