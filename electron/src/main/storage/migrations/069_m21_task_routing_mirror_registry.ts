// electron/src/main/storage/migrations/069_m21_task_routing_mirror_registry.ts
//
// M2.1 Task 6（RM-M21-2/7）：任务路由数据面 + 镜像登记表。
//   - tasks + routing_json TEXT NULL：TaskRouting 三选一（local/group/node）的 JSON
//     序列化；NULL = 未指定（含迁移前旧行）→ 读侧 parseTaskRouting 兜底 {mode:'local'}。
//   - tasks + delegation_id TEXT NULL：hub 委派 id 关联（T8 提交链回写 / T9 delegation-sync
//     同步消费；本迁移仅落列）。
//   - workspace_mirror_registry 新表：workspace.mirrored 组内广播的累积登记
//     （同组×同节点×同空间唯一，覆盖 snapshot_id）——T3 徽标/T4 选择器/T7 调度/
//     T8 守门四消费方同源（RM-M21-7，严禁任务史推导）。
//     失忆限制：M2 协议无事件重放/无查询 RPC——登记表只含本机在线期间收到的广播，
//     晚入组/离线期间的镜像不可恢复；M3 以 hub 查询式清单 RPC 补齐。
export const version = 69;
export const up = `
ALTER TABLE tasks ADD COLUMN routing_json TEXT NULL;
ALTER TABLE tasks ADD COLUMN delegation_id TEXT NULL;

CREATE TABLE IF NOT EXISTS workspace_mirror_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  group_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  mirrored_at INTEGER NOT NULL,
  UNIQUE(group_id, target_node_id, workspace_name)
);
`;
