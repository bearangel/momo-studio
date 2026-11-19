// electron/src/main/storage/migrations/084_recurrence_chain_root.ts
//
// 循环任务链根（2026-11-19 归档聚合 spec）：tasks.recurrence_chain_root 列。
// 背景：循环任务每次到点生成新实例行（recurrence_parent_id 链到前任），
// 完成实例堆积已完成泳道/归档面板（同名任务平铺）。产品决策：续期成功即
// 自动归档旧实例 + 归档面板按链聚合展示（「日报 · 循环 N 次」一行可展开）。
// 聚合键 = 链根：spawn 时继承（前任 root ?? 前任 id）——恒等于链上第一个
// 任务的 id。本迁移对存量链递归回填（SQLite WITH RECURSIVE 沿 parent 链
// 上溯到根；链头任务自身 root 留 NULL——「根任务」与「非循环任务」都不需
// 要聚合键，语义：recurrence_chain_root IS NOT NULL ⟺ 该行是链上第 ≥2 个
// 实例。根任务靠 GROUP BY 归并时以「链根 id」做组键（列值 NULL 的根行用
// id 自身参与，聚合查询自行 COALESCE）。
export const version = 84;
export const up = `
ALTER TABLE tasks ADD COLUMN recurrence_chain_root TEXT;

WITH RECURSIVE chain(id, root_id) AS (
  SELECT id, id FROM tasks WHERE recurrence_parent_id IS NULL
  UNION ALL
  SELECT t.id, c.root_id FROM tasks t JOIN chain c ON t.recurrence_parent_id = c.id
)
UPDATE tasks SET recurrence_chain_root = (
  SELECT root_id FROM chain WHERE chain.id = tasks.id
) WHERE recurrence_parent_id IS NOT NULL;
`;
