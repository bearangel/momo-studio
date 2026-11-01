// electron/src/main/storage/migrations/071_task_origin_column.ts
//
// D4 账本与存储包（spec 2026-10-31-ledger-storage-package §3.1）：tasks.origin
// 来源判别列——dispatch 子任务入账（registry 单向持久化投影）后，区分用户任务
// 与编排簿记行：executor 并发槽排除、看板「编排」徽标、只读守卫、启动对账
// 四处消费。存量行 DEFAULT 'user'（迁移即回填）。
export const version = 71;
export const up = `
ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';
`;
