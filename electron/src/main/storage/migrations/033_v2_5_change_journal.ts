// electron/src/main/storage/migrations/033_v2_5_change_journal.ts
//
// v2.5 Migration v33：变更账本 journal_entries 表（变更账本与撤销，工具防御第三期）。
// 设计依据 docs/specs/2026-09-10-change-journal-undo-design.md §5.2 + 实施计划精化。
//
// 与 spec §5.2 草稿的差异（计划精化，实现裁定非偏离）：
//   1. **无 message_id 列**——消息行在流结束才落库，工具记账（落盘前）时该 id
//      不存在；归组键统一 stream_session_id（UI 经 streamSessionId→message
//      反查定位消息），对应地索引用 idx_journal_stream 取代 spec 的 idx_journal_message。
//   2. session_id 可空——对齐 TS JournalEntry.sessionId: string | null 边界
//      （ctx.roomId 理论上恒有，但类型面允许缺省，列 nullability 与之一致）。
//   3. op 加 CHECK 约束——锁死 create/modify/delete/rename 四值域
//      （revert 逆序执行按 op 分派逆操作，脏值入账即炸；v24 platform CHECK 先例）。
//
// 不建 workspace_id 外键：spec §5.2 未声明；journal 生命周期归配额清理（quota.ts）
// 所有，workspace 删除时残留行无害（按 workspace_id 精确命中，v7 git_policies 同款裁定）。

export interface Migration033 {
  version: number;
  up: string;
  down: string;
}

export const migration033: Migration033 = {
  version: 33,
  up: `
    -- ─── v33：v2.5 变更账本（journal + content-addressed 快照）─────────────────
    -- 条目（轻量可查询）入 state.db；大内容 blob 落 userData 文件系统
    -- （<userData>/journal/<workspaceId>/objects/<hash[0:2]>/<hash>，D6 决策）。
    -- path 存 workspace 相对路径（展示与对账键）；hash 为 sha256 hex。
    CREATE TABLE IF NOT EXISTS journal_entries (
      id                TEXT PRIMARY KEY NOT NULL,  -- je_<uuid>
      workspace_id      TEXT NOT NULL,
      task_id           TEXT,                       -- 可空：快速会话无任务
      session_id        TEXT,                       -- 可空：对齐 JournalEntry.sessionId 边界
      stream_session_id TEXT NOT NULL,              -- 归组键：消息行流（流结束才落库 → 无 message_id）
      tool_name         TEXT NOT NULL,              -- write_file / edit_file / apply_patch / rm / mv / undo
      path              TEXT NOT NULL,
      op                TEXT NOT NULL CHECK (op IN ('create','modify','delete','rename')),
      before_hash       TEXT,                       -- create 前 / rename 旧内容 hash
      after_hash        TEXT,                       -- delete 后为空
      old_path          TEXT,                       -- 仅 rename
      created_at        INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_journal_task ON journal_entries (workspace_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_journal_stream ON journal_entries (workspace_id, stream_session_id);
  `.trim(),
  down: `
    -- forward-only：不提供回滚（与 v32 同约定）
    SELECT 1;
  `.trim(),
};
