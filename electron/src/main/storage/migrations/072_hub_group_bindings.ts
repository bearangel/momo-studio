// electron/src/main/storage/migrations/072_hub_group_bindings.ts
//
// 平行模式（spec 2026-11-05-workgroup-peer-mode-design.md §4.2）：peer 组承接
// 空间绑定的本地权威表。hub 侧登记按空间名（组内可见），本地另存 workspaceId
// ——草稿落点与镜像 applyTo:'binding' 的解析键（按名解析会撞本地改名/同名空间）。
// acceptsMirror 不落本地：hub group.list 投影（GroupMember.acceptsMirror）即 UI
// 与组长镜像界面的数据源，避免两份开关漂移。
export const version = 72;
export const up = `
CREATE TABLE IF NOT EXISTS hub_group_bindings (
  group_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;
