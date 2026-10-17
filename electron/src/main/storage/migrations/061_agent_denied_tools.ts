// electron/src/main/storage/migrations/061_agent_denied_tools.ts
//
// 插件平台工作空间维度 v1.1（spec 2026-10-17 §7.1）：agent 级工具门控存储。
// 模式串语法复用 tools/shared/permission.ts matchToolPattern（plugin:<id>/* 整插件前缀 + 精确名）。
export interface Migration061 {
  version: number;
  up: string;
  down: string;
}

export const migration061: Migration061 = {
  version: 61,
  up: `
    ALTER TABLE agent_definitions ADD COLUMN denied_tools TEXT NOT NULL DEFAULT '[]';
  `.trim(),
  down: `
    -- SQLite 旧版无 DROP COLUMN——down 仅文档化（测试直调仅验 up，惯例同 058-060）
  `.trim(),
};
