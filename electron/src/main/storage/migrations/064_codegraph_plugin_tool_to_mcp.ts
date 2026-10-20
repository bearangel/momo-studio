// electron/src/main/storage/migrations/064_codegraph_plugin_tool_to_mcp.ts
//
// 功能迁移（2026-10-20 引擎整合 spec §5.2）：codegraph 插件 v2.0 工具面
// 退役——成员级 plugin:codegraph/* 门控行迁移至 MCP server 级门控。
// INSERT OR IGNORE：成员已有同键 mcp 行时不冲突；原 plugin_tool 行全删。
// LIKE 覆盖整组(plugin:codegraph/*)与单工具行——单工具禁用保守升级为 server 级禁用。
export interface Migration064 {
  version: number;
  up: string;
  down: string;
}

export const migration064: Migration064 = {
  version: 64,
  up: `
    INSERT OR IGNORE INTO agent_assignment_capabilities (assignment_id, capability_type, mode, ref)
      SELECT assignment_id, 'mcp', 'remove', 'codegraph'
      FROM agent_assignment_capabilities
      WHERE capability_type='plugin_tool' AND mode='remove' AND ref LIKE 'plugin:codegraph/%';
    DELETE FROM agent_assignment_capabilities
      WHERE capability_type='plugin_tool' AND ref LIKE 'plugin:codegraph/%';
  `.trim(),
  down: `
    -- down 保守：只清除迁移产物行，不重建 plugin_tool 行（v2.0 工具面已不存在）
    DELETE FROM agent_assignment_capabilities
      WHERE capability_type='mcp' AND mode='remove' AND ref='codegraph';
  `.trim(),
};
