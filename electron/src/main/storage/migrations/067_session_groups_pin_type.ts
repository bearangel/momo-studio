// electron/src/main/storage/migrations/067_session_groups_pin_type.ts
//
// 会话体验优化（spec 2026-10-22 §3）：
//   1. session_groups 表（会话手动分组；position 镜像 task_groups 的 (i+1)*1024 契约）
//   2. sessions 三新列：pinned_at（非空即置顶，值=置顶时间戳）/ group_id（分组归属）/
//      session_type（'quick'|'collab'；NULL=泛化创建路径，图标按 kind 判定）
//   3. 存量回填：仅 chat 行按成员数一次推断（此后由创建路径定型，不再推断）
export const version = 67;
export const up = `
-- ─── 067：会话分组 / 置顶 / 类型（spec 2026-10-22）─────────────────────────
CREATE TABLE IF NOT EXISTS session_groups (
  id           TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name         TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_groups_ws ON session_groups(workspace_id, position);
ALTER TABLE sessions ADD COLUMN pinned_at INTEGER;
ALTER TABLE sessions ADD COLUMN group_id TEXT REFERENCES session_groups(id);
ALTER TABLE sessions ADD COLUMN session_type TEXT;
UPDATE sessions SET session_type =
  CASE WHEN (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = sessions.id) > 1
  THEN 'collab' ELSE 'quick' END
WHERE kind = 'chat';
`;
