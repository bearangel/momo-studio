// electron/src/main/storage/migrations/035_v2_7_browser_takeover_wait.ts
//
// v35：接管驻留等待与空闲自愈时长（spec 2026-09-14 §4.4）。
// workspace_settings 加两列——agent 驻留等待（默认 120000，0=立即失败）/ 空闲自动回切
// 阈值（默认 90000，0=关闭自愈）。DEFAULT 保证既有库零迁移即可落正确值，settings-store
// 读侧对缺失列回退 DEFAULT 仍是同一语义（行惰性创建前不会发生）。
// 缺省 120000 > idle 90000：自愈可达性不变式（终审 I1；v35 未发布，直接改列默认值）。
//
// 幂等：runMigrations 按 schema_migrations.version 跳过；ADD COLUMN 自身也允许重跑
//（SQLite 对同名列二次 ADD 会报错，但 schema_migrations 保护已挡在前面）。

export interface Migration035 {
  version: number;
  up: string;
  down: string;
}

export const migration035: Migration035 = {
  version: 35,
  up: `
    -- ─── v35：v2.7 McpBrowser 接管驻留等待设置（spec 2026-09-14 §4.4）────────
    -- agentWaitMs：agent 工具调用遇 user 态时驻留等待上限（毫秒）；
    --   0=关闭等待（user 态立即失败，v1 fail-fast 行为），>0=等用户释放或超时
    -- idleAutoReleaseMs：user 接管后空闲自动回切 agent 阈值（毫秒）；
    --   0=关闭自愈，>0=空闲超过此值自动回 agent 态
    ALTER TABLE workspace_settings ADD COLUMN agent_wait_ms INTEGER NOT NULL DEFAULT 120000;
    ALTER TABLE workspace_settings ADD COLUMN idle_auto_release_ms INTEGER NOT NULL DEFAULT 90000;
  `.trim(),
  down: `
    -- forward-only：不提供回滚（与 v32/v33/v34 同约定）
    SELECT 1;
  `.trim(),
};
