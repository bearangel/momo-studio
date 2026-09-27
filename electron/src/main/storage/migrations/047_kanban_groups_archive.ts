// electron/src/main/storage/migrations/047_kanban_groups_archive.ts
//
// 任务看板重构（spec 2026-09-27 §2）：分组表 + tasks 三新列。
// 全部可空/带默认，老数据零处理开箱即用。

export const migration047 = {
  version: 47,
  sql: `
CREATE TABLE task_groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  position REAL NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_task_groups_ws ON task_groups(workspace_id);

ALTER TABLE tasks ADD COLUMN group_id TEXT REFERENCES task_groups(id);
ALTER TABLE tasks ADD COLUMN board_position REAL;
ALTER TABLE tasks ADD COLUMN archived_at INTEGER;
CREATE INDEX idx_tasks_ws_archived ON tasks(workspace_id, archived_at);
`.trim(),
};
