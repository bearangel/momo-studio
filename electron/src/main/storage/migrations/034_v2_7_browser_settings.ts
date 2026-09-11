// electron/src/main/storage/migrations/034_v2_7_browser_settings.ts
//
// v2.7 Migration v34：McpBrowser workspace 级浏览器设置（spec 2026-09-11 §9）。
//
// ⚠️ 与 spec §9 草稿的两处差异（保真修正，均为现实所迫）：
//   1. 版本号 034 而非 v32——032/033 已被 v2.3（apply_patch）/ v2.5（change
//      journal）占用；runMigrations 以 schema_migrations.version 为跳过依据
//      （db.ts `applied.has(m.version)`），重复版本号会让本迁移在所有库上被
//      静默跳过（列永远加不上）。
//   2. CREATE TABLE 而非 ALTER TABLE ADD COLUMN——spec 预设 workspace_settings
//      已存在，实际 v1→v33 从未建过该表（全库无此表名）。六列的列名 / 类型 /
//      NOT NULL / DEFAULT 与 spec §9 逐字一致。
//
// 幂等：CREATE TABLE IF NOT EXISTS（双跑 runMigrations 天然 no-op）。
// 行由 settings-store 的 upsert 惰性创建——migration 不回填存量 workspace 行
//（读侧对缺失行回退默认 ask/false/[]/[]/false/380，语义与列 DEFAULT 等价）。

export interface Migration034 {
  version: number;
  up: string;
  down: string;
}

export const migration034: Migration034 = {
  version: 34,
  up: `
    -- ─── v34：v2.7 McpBrowser 浏览器设置（spec 2026-09-11 §9）──────────────────
    -- workspace 级浏览器策略四列 + 侧栏 UI 偏好两列；黑白名单存 JSON 数组文本。
    -- 删 workspace 级联清行（设置行生命周期归属 workspace）。
    CREATE TABLE IF NOT EXISTS workspace_settings (
      workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      trust_browser TEXT NOT NULL DEFAULT 'ask',
      browser_evaluate_enabled INTEGER NOT NULL DEFAULT 0,
      browser_domain_blacklist TEXT NOT NULL DEFAULT '[]',
      browser_domain_whitelist TEXT NOT NULL DEFAULT '[]',
      browser_sidebar_collapsed INTEGER NOT NULL DEFAULT 0,
      browser_sidebar_width INTEGER NOT NULL DEFAULT 380
    );
  `.trim(),
  down: 'DROP TABLE IF EXISTS workspace_settings;',
};
