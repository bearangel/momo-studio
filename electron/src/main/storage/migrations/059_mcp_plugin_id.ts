// electron/src/main/storage/migrations/059_mcp_plugin_id.ts
//
// 插件系统 P2（spec §10）：mcp_definitions 归属列——source='plugin' 行回溯
// 注册插件（卸载级联精确删除，不误伤他插件条目）。
export interface Migration059 {
  version: number;
  up: string;
  down: string;
}

export const migration059: Migration059 = {
  version: 59,
  up: `
    ALTER TABLE mcp_definitions ADD COLUMN plugin_id TEXT;
  `.trim(),
  down: `
    -- SQLite 旧版无 DROP COLUMN——down 仅文档化（测试直调仅验 up）
  `.trim(),
};
