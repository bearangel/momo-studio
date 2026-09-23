// electron/src/main/storage/migrations/039_p21_mcp_bundle_cwd.ts
//
// P2.1 Migration 039：mcp_definitions 支持 cwd 列（DXT/MCPB bundle 导入前置）。
// bundle 类命令（node ${__dirname}/server/index.js 或相对 entry）需要显式工作
// 目录兜底；nullable——remote 行与常规 stdio 行不落值，读取侧 ?? undefined 还原
// 缺省语义（不改 spawn 工作目录）。

export interface Migration039 {
  version: number;
  up: string;
  down: string;
}

export const migration039: Migration039 = {
  version: 39,
  up: `
    -- stdio bundle 类命令的工作目录（DXT/MCPB 导入双保险）；NULL = 缺省（不改 cwd）
    ALTER TABLE mcp_definitions ADD COLUMN cwd TEXT;
  `.trim(),
  down: `
    -- SQLite 不支持 DROP COLUMN 前的索引依赖清理，forward-only 不回滚
    SELECT 1;
  `.trim(),
};
