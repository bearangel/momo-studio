// electron/src/main/storage/migrations/038_p2_mcp_remote_transport.ts
//
// P2 Migration 038：mcp_definitions 支持远程 MCP（spec 2026-09-22 §4.2）。
// transport 列已存在（DEFAULT 'stdio'），本迁移只加 url / headers_json 两 nullable 列。
// command 列 NOT NULL 不动——remote 行以空串占位（getMcpConfig 按 transport 分流读取），
// 避免SQLite 重建表的 NOT NULL 改写风险。

export interface Migration038 {
  version: number;
  up: string;
  down: string;
}

export const migration038: Migration038 = {
  version: 38,
  up: `
    -- 远程 MCP 两列：端点 URL 与请求头（token 等）。stdio 行两列为 NULL。
    ALTER TABLE mcp_definitions ADD COLUMN url TEXT;
    ALTER TABLE mcp_definitions ADD COLUMN headers_json TEXT;
  `.trim(),
  down: `
    -- SQLite 不支持 DROP COLUMN 前的索引依赖清理，forward-only 不回滚
    SELECT 1;
  `.trim(),
};
