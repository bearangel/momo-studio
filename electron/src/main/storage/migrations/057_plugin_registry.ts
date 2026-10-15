// electron/src/main/storage/migrations/057_plugin_registry.ts
//
// 插件系统 P1（spec 2026-10-15 §7.1）：机器级注册表 + workspace 级启停两表。
// 与 040 同款：模块内带 down 供测试直调；迁移数组只接 .up。
export interface Migration057 {
  version: number;
  up: string;
  down: string;
}

export const migration057: Migration057 = {
  version: 57,
  up: `
    -- 机器级插件注册表。source: 'zip'（安装目录不可变副本）| 'dev'（源目录直读不拷贝）。
    -- state: 'active' | 'missing'（dev 源目录消失时由读路径标降级，见 plugin/registry.ts）
    CREATE TABLE plugins (
      id            TEXT PRIMARY KEY NOT NULL,
      version       TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      state         TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'missing')),
      source        TEXT NOT NULL CHECK (source IN ('zip', 'dev')),
      source_path   TEXT,
      installed_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- workspace 级启停。行缺失 = 启用（默认开启语义，仅禁用/重启用落行）。
    CREATE TABLE plugin_enablements (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      plugin_id    TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
      enabled      INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      PRIMARY KEY (workspace_id, plugin_id)
    );
  `.trim(),
  down: `
    DROP TABLE IF EXISTS plugin_enablements;
    DROP TABLE IF EXISTS plugins;
  `.trim(),
};
