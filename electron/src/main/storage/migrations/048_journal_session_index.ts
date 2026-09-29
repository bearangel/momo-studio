// electron/src/main/storage/migrations/048_journal_session_index.ts
//
// Migration 048：journal_entries 会话级索引（变更回滚重构，spec
// docs/specs/2026-09-28-journal-rollback-redesign.md §5.2）。
//
// 背景：会话级整体回滚入口（SessionRollbackButton → journal:list scope
// sessionId）需要按 (workspace_id, session_id) 聚合该会话全部条目——含子
// agent dispatch 写入（同 session_id、不同 stream_session_id）。v33 建表只
// 建了 task/stream 两组索引，session 维度全表扫。session_id 可空（v33 裁定），
// NULL 行不参与等值命中，语义自然成立。
//
// down 为真 DROP INDEX（模块内供测试直调；迁移数组只接 .up，042 同款约定）。

export interface Migration048 {
  version: number;
  up: string;
  down: string;
}

export const migration048: Migration048 = {
  version: 48,
  up: `
    -- 会话级回滚聚合索引（journal:list scope sessionId 查询支撑）
    CREATE INDEX IF NOT EXISTS idx_journal_session
      ON journal_entries (workspace_id, session_id);
  `.trim(),
  down: `
    DROP INDEX IF EXISTS idx_journal_session;
  `.trim(),
};
