// electron/src/main/storage/migrations/040_p22_mcp_config_schema.ts
//
// P2.2 Migration 040：mcp_definitions 加 config_schema 列（远程 MCP 配置表单元数据）。
// Smithery 安装时把详情接口的 configSchema（required/properties/x-from 分流元数据）
// 原样落库，供后续配置编辑功能（P2.2 Task 4 表单回填）消费。
// NOT NULL DEFAULT '{}'——缺省视为无 schema（读取侧 '{}' 解析回 undefined）。
// down 写真 DROP COLUMN（Task 0 冒烟已证本机 SQLite 支持；039 的 no-op down 是
// 历史惯例，不照抄——P2.2 红测明确要求 down 后列消失）。

export interface Migration040 {
  version: number;
  up: string;
  down: string;
}

export const migration040: Migration040 = {
  version: 40,
  up: `
    -- 远程 MCP 配置表单元数据（Smithery configSchema，JSON 序列化）；'{}' = 无 schema
    ALTER TABLE mcp_definitions ADD COLUMN config_schema TEXT NOT NULL DEFAULT '{}';
  `.trim(),
  down: `
    ALTER TABLE mcp_definitions DROP COLUMN config_schema;
  `.trim(),
};
