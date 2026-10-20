// electron/src/main/storage/migrations/065_plugin_mcp_backfill_allocations.ts
//
// D2 裁定（2026-10-20）：插件 MCP 装即注入所有工作空间——存量库一次性回填
// （新装插件走 install 链注入、新工作空间走 createWorkspace 回填，本迁移只管
// 既有 plugin MCP × 既有 ws 的对齐；幂等可重放）。
export interface Migration065 {
  version: number;
  up: string;
  down: string;
}

export const migration065: Migration065 = {
  version: 65,
  up: `
    INSERT OR IGNORE INTO workspace_allocations (workspace_id, capability_type, capability_ref, added_at)
      SELECT w.id, 'mcp', d.name, datetime('now')
      FROM workspaces w
      CROSS JOIN mcp_definitions d
      WHERE d.source = 'plugin';
  `.trim(),
  down: `
    -- down 保守：只清 plugin 来源 MCP 的注入行（用户手工添加的 custom MCP 行不动）
    DELETE FROM workspace_allocations
      WHERE capability_type = 'mcp'
        AND capability_ref IN (SELECT name FROM mcp_definitions WHERE source = 'plugin');
  `.trim(),
};
