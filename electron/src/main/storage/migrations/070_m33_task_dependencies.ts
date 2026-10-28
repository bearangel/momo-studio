// electron/src/main/storage/migrations/070_m33_task_dependencies.ts
//
// M3.3 任务编排与依赖（spec 2026-10-29 §2.1）：任务层级 + 依赖边表。
//   - tasks + parent_task_id TEXT NULL：父任务引用（层级链，区别于循环实例链
//     recurrence_parent_id）；引用 tasks.task_id，写路径校验存在（校验存在即可，
//     终态 parent 允许挂在历史下），链无环由 task/dependency-graph.ts 环检测保证。
//   - task_dependencies 新表：任务依赖边（task_id 依赖 depends_on_task_id），
//     复合主键防重复边；CHECK 防自环（SQL 兜底，JS 写路径另有自环人话校验）。
//   - 双索引：task_id（正向查「我依赖谁」）/ depends_on_task_id（反向查「谁依赖我」，
//     依赖完成后反向定位受影响任务）。
// blocked 派生态不落列、不加状态（M3.1 waiting 先例）——读侧 JOIN 聚合派生。
export const version = 70;
export const up = `
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT NULL;

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_task_id ON task_dependencies (task_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies (depends_on_task_id);
`;
