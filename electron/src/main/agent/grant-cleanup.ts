// electron/src/main/agent/grant-cleanup.ts
//
// 卸载级联清授权（spec 2026-10-21 §8）：本插件的能力授权行一并清除——
// agent_assignment_capabilities 的 plugin_tool 前缀/组模式行与 skill 精确行、
// workspace_allocations 的 skill 行。防同 id 重装冒用继承（marketplace 无签名，
// id 可冒用——与引擎整合终审 I2「敏感键随数据删」同判）。
import { getDb } from '../storage/db';

export function removePluginCapabilityGrants(pluginId: string, skillSlugs: string[]): void {
  const db = getDb();
  db.prepare(
    `DELETE FROM agent_assignment_capabilities
     WHERE capability_type = 'plugin_tool' AND (ref LIKE ? OR ref = ?)`,
  ).run(`plugin:${pluginId}/%`, `plugin:${pluginId}/*`);
  if (skillSlugs.length > 0) {
    const ph = skillSlugs.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM agent_assignment_capabilities WHERE capability_type = 'skill' AND ref IN (${ph})`,
    ).run(...skillSlugs);
    db.prepare(
      `DELETE FROM workspace_allocations WHERE capability_type = 'skill' AND capability_ref IN (${ph})`,
    ).run(...skillSlugs);
  }
}
