// electron/src/main/storage/migrations/058_tool_call_source.ts
//
// 插件系统 P2（spec 2026-10-15 §4.3）：工具审计溯源列——内置工具 'builtin'（默认）、
// 插件工具 'plugin'。与 040/057 同款：模块内带 down 供测试直调；迁移数组只接 .up。
export interface Migration058 {
  version: number;
  up: string;
  down: string;
}

export const migration058: Migration058 = {
  version: 58,
  up: `
    ALTER TABLE tool_calls ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin';
  `.trim(),
  down: `
    -- SQLite 不支持 DROP COLUMN（旧版本）——down 以重建表方式省略，测试直调仅验 up。
  `.trim(),
};
