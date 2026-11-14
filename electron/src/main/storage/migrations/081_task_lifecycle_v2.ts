// electron/src/main/storage/migrations/081_task_lifecycle_v2.ts
//
// 任务生命周期 v2（spec 2026-11-13-task-lifecycle-v2-design §5.5）：tasks 五列 +
// messages.meta_json + task_runs（执行尝试）+ human_requests（人工请求）。
// 结构迁移；存量数据回填在 082（run #1 / current_run_id / dispatch 自动验收）。
export const version = 81;
export const up = `
ALTER TABLE tasks ADD COLUMN current_run_id TEXT;
ALTER TABLE tasks ADD COLUMN submitted_at INTEGER;
ALTER TABLE tasks ADD COLUMN accepted_at INTEGER;
ALTER TABLE tasks ADD COLUMN delegation_role TEXT;
ALTER TABLE tasks ADD COLUMN auto_accept INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN meta_json TEXT;

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  execution_session_id TEXT,
  trigger TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  deliverable_json TEXT,
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(task_id, run_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_active
  ON task_runs(task_id) WHERE status IN ('running','waiting_human','submitted');
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, run_no);

CREATE TABLE IF NOT EXISTS human_requests (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  delegation_id TEXT,
  origin_node_id TEXT,
  remote_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  payload_json TEXT,
  options_json TEXT,
  assignee_node_id TEXT,
  authority_json TEXT,
  deadline_at INTEGER,
  timeout_policy TEXT NOT NULL DEFAULT 'keep_waiting',
  last_reminded_at INTEGER,
  answer_json TEXT,
  answered_by_node_id TEXT,
  answered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(origin_node_id, remote_id)
);
CREATE INDEX IF NOT EXISTS idx_human_requests_session ON human_requests(session_id, status);
CREATE INDEX IF NOT EXISTS idx_human_requests_task ON human_requests(task_id, status);
CREATE INDEX IF NOT EXISTS idx_human_requests_assignee ON human_requests(assignee_node_id, status);
`;
