// electron/src/main/storage/migrations/062_assignment_plugin_tool_delta.ts
//
// 功能全面性规则（2026-10-17）：成员级插件工具覆盖——deltas 行模型扩
// capability_type='plugin_tool'。SQLite 不能 ALTER CHECK，走表重建：
// 新表（CHECK 扩四值）→ 拷数据 → drop 旧 → 改名。数据零丢失。
export interface Migration062 {
  version: number;
  up: string;
  down: string;
}

export const migration062: Migration062 = {
  version: 62,
  up: `
    CREATE TABLE agent_assignment_capabilities_v062 (
      assignment_id   TEXT NOT NULL REFERENCES workspace_agent_members(instance_id) ON DELETE CASCADE,
      capability_type TEXT NOT NULL CHECK (capability_type IN ('tool','mcp','skill','plugin_tool')),
      mode            TEXT NOT NULL CHECK (mode IN ('add','remove')),
      ref            TEXT NOT NULL,
      PRIMARY KEY (assignment_id, capability_type, mode, ref)
    );
    INSERT INTO agent_assignment_capabilities_v062 (assignment_id, capability_type, mode, ref)
    SELECT c.assignment_id, c.capability_type, c.mode, c.ref
    FROM agent_assignment_capabilities c
    JOIN workspace_agent_members m ON m.instance_id = c.assignment_id;
    DROP TABLE agent_assignment_capabilities;
    ALTER TABLE agent_assignment_capabilities_v062 RENAME TO agent_assignment_capabilities;
  `.trim(),
  down: `
    -- down 不恢复旧 CHECK（plugin_tool 行删除即可回到旧语义，表结构兼容）
    DELETE FROM agent_assignment_capabilities WHERE capability_type = 'plugin_tool';
  `.trim(),
};
