// electron/src/main/storage/migrations/063_remove_p2p_lsp_residue.ts
//
// P2P 联网与 LSP 子系统移除（2026-10-20，spec docs/specs/2026-10-20-remove-p2p-lsp-design.md）：
// schema 与存量数据的彻底清（用户裁定 A）。
//   1. tasks.source_node_id（migration 019 的 P2P 路由列）DROP——SQLite ≥3.35 支持
//      DROP COLUMN（better-sqlite3 v12 内嵌 ≥3.44）；该列无索引，直删安全
//   2. messages.source IN ('lan','hub') 的 P2P 镜像行 DELETE——来源节点已不存在，
//      行语义死亡（本地链路 source 恒 'local'，列与 CHECK 不动）
//   3. agent_definitions.default_tools 的 lsp_* 休眠引用清理——migration 016 种子
//      （历史不可变）与 2026-10-08 下架期的 YAML 休眠引用都可能在存量库残留；
//      json_each 过滤重建，无 lsp 引用的行零触碰
//   注：P2P 资源目录是内存态（remote-cache 不落盘、分享条目不写库），无资源行需清。
export interface Migration063 {
  version: number;
  up: string;
  down: string;
}

export const migration063: Migration063 = {
  version: 63,
  up: `
    ALTER TABLE tasks DROP COLUMN source_node_id;
    DELETE FROM messages WHERE source IN ('lan', 'hub');
    UPDATE agent_definitions
    SET default_tools = (
      SELECT json_group_array(json(value))
      FROM json_each(agent_definitions.default_tools)
      WHERE json_extract(value, '$.ref') NOT LIKE 'lsp_%'
    )
    WHERE default_tools IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM json_each(agent_definitions.default_tools)
        WHERE json_extract(value, '$.ref') LIKE 'lsp_%'
      );
  `.trim(),
  down: `
    -- down 不恢复（P2P/LSP 子系统已删除，列与数据无消费者）
    ALTER TABLE tasks ADD COLUMN source_node_id TEXT;
  `.trim(),
};
