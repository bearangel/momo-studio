// electron/src/main/storage/migrations/066_plugin_scoped_activation.ts
//
// 插件作用域激活（spec 2026-10-21 §4）：enablements 默认语义翻转为「行缺失=停用」，
// 本迁移为存量库一次性回填全部 (ws × plugin) = enabled=1（存量决策 A：保持现状）。
// 新装插件 / 新建 ws 不回填——走安装链单行写入（spec §5）。
// skill 授权物化不在迁移内（纯 SQL 无法扫盘取 slug）——由启动期回填承担
// （plugin/legacy-grants.ts，installed_at 截止日判定）。
export interface Migration066 {
  version: number;
  up: string;
  down: string;
}

export const migration066: Migration066 = {
  version: 66,
  up: `
    INSERT OR IGNORE INTO plugin_enablements (workspace_id, plugin_id, enabled)
      SELECT w.id, p.id, 1 FROM workspaces w CROSS JOIN plugins p;
  `.trim(),
  down: `
    -- down 保守：回填行与用户手写行不可区分，只删「全 ws 对齐」的行集合
    DELETE FROM plugin_enablements
    WHERE (plugin_id, workspace_id) IN (
      SELECT pe.plugin_id, pe.workspace_id FROM plugin_enablements pe
      WHERE (SELECT COUNT(*) FROM workspaces) =
        (SELECT COUNT(*) FROM plugin_enablements WHERE plugin_id = pe.plugin_id AND enabled = 1)
    );
  `.trim(),
};
