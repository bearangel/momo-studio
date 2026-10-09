// electron/src/main/storage/migrations/053_mcp_enabled.ts
// 组⑤（2026-10-09 真机走查遗留 D13）：MCP 启停——mcp_definitions 加 enabled 列。
// 禁用 = 定义保留、运行时切断（getOrStartMcp 拒绝 + 池驱逐 + spawn 过滤）；
// 存量行全 1（默认启用，零行为变化）。注册链 INSERT OR REPLACE 不含该列——
// 重装即新装，enabled 回默认 1（覆盖安装语义本就如此）。
// down 写真 DROP COLUMN（本机 SQLite 支持，040 已验证同款）。

/** 与 040 同款：模块内带 down 供测试直调；迁移数组只接 .up */
export interface Migration053 {
  version: number;
  up: string;
  down: string;
}

export const migration053: Migration053 = {
  version: 53,
  up: `
    -- MCP 启停开关（1=启用 / 0=禁用）；注册链不含该列，INSERT 走 DEFAULT 1
    ALTER TABLE mcp_definitions ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
  `.trim(),
  down: `
    ALTER TABLE mcp_definitions DROP COLUMN enabled;
  `.trim(),
};
