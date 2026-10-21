// electron/src/main/plugin/legacy-grants.ts
//
// 存量 skill 授权回填（spec 2026-10-21 §4 修订版）：installed_at 截止日前的插件，
// 其 skill 授权物化为 ws allocation 行（存量决策 A——存量 agent 经 Layer 2 显式
// 授权继续可见）。迁移是内联纯 SQL 无法扫盘取 slug，故由启动期承担；幂等可重放。
import { listPlugins } from './registry';
import { listAllPluginSkills, resolvePluginRoot } from './assembly';
import { getDb } from '../storage/db';

const CUTOFF = '2026-10-21';

export function backfillLegacyPluginSkillGrants(cutoffIso: string = CUTOFF): void {
  const legacy = listPlugins().filter((p) => p.installedAt < cutoffIso && p.state === 'active');
  if (legacy.length === 0) return;
  const all = listAllPluginSkills();
  const ins = getDb().prepare(
    `INSERT OR IGNORE INTO workspace_allocations (workspace_id, capability_type, capability_ref) VALUES (?, 'skill', ?)`,
  );
  const wsIds = getDb().prepare(`SELECT id FROM workspaces`).all() as Array<{ id: string }>;
  for (const rec of legacy) {
    if (resolvePluginRoot(rec) === null) continue; // missing 态跳过（目录恢复后重放补）
    const slugs = all.filter((s) => s.pluginId === rec.id).map((s) => s.slug);
    for (const { id: ws } of wsIds) {
      for (const slug of slugs) ins.run(ws, slug);
    }
  }
}
