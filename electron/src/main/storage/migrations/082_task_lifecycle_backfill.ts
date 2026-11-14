// electron/src/main/storage/migrations/082_task_lifecycle_backfill.ts
//
// 任务生命周期 v2 回填（spec 2026-11-13-task-lifecycle-v2-design §5.5）：
//   1) 存量 in_progress/paused 任务补 run #1（无则补；幂等由 NOT EXISTS 保证）
//   2) current_run_id 指向活动 run
//   3) origin='dispatch' 簿记行强制 auto_accept=1（spec §6.9）
// 刻意不做：delegation_role 回填（SQL 缺 selfNodeId 判据，运行期单点写，spec §12）。
export const version = 82;
export const up = `
INSERT INTO task_runs (id, task_id, run_no, status, execution_session_id, trigger, started_at, created_at, updated_at)
SELECT lower(hex(randomblob(16))), t.id, 1, 'running', t.execution_session_id, 'initial',
       COALESCE(t.started_at, t.created_at), t.created_at, t.updated_at
FROM tasks t
WHERE t.status IN ('in_progress','paused')
  AND NOT EXISTS (SELECT 1 FROM task_runs r WHERE r.task_id = t.id);

UPDATE tasks
SET current_run_id = (
  SELECT r.id FROM task_runs r
  WHERE r.task_id = tasks.id AND r.status IN ('running','waiting_human','submitted')
  ORDER BY r.run_no DESC LIMIT 1
)
WHERE current_run_id IS NULL;

UPDATE tasks SET auto_accept = 1 WHERE origin = 'dispatch';
`;
