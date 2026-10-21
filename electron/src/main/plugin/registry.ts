// electron/src/main/plugin/registry.ts
//
// plugins / plugin_enablements 两表的读写门面（spec §7.1）。
// dev 源 missing 检测在读路径完成：sourcePath 目录消失 → 标 missing 并回写
// DB（UI 徽标 + P2 装配跳过的依据）；目录恢复 → 回 active。
import fs from 'node:fs';
import { getDb } from '../storage/db';
import type { PluginRecord } from './types';

interface PluginRow {
  id: string;
  version: string;
  manifest_json: string;
  state: string;
  source: string;
  source_path: string | null;
  installed_at: string;
}

function rowToRecord(row: PluginRow): PluginRecord {
  return {
    id: row.id,
    version: row.version,
    manifestJson: row.manifest_json,
    state: row.state as PluginRecord['state'],
    source: row.source as PluginRecord['source'],
    sourcePath: row.source_path,
    installedAt: row.installed_at,
  };
}

export function listPlugins(): PluginRecord[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM plugins ORDER BY id`).all() as PluginRow[];
  const out: PluginRecord[] = [];
  for (const row of rows) {
    const rec = rowToRecord(row);
    if (rec.source === 'dev' && rec.sourcePath && !fs.existsSync(rec.sourcePath)) {
      if (rec.state !== 'missing') {
        db.prepare(`UPDATE plugins SET state = 'missing' WHERE id = ?`).run(rec.id);
        rec.state = 'missing';
      }
    } else if (rec.state === 'missing') {
      // dev 目录恢复 → 回 active（读路径自愈，无需重装）
      db.prepare(`UPDATE plugins SET state = 'active' WHERE id = ?`).run(rec.id);
      rec.state = 'active';
    }
    out.push(rec);
  }
  return out;
}

export function getPlugin(id: string): PluginRecord | null {
  const row = getDb()
    .prepare(`SELECT * FROM plugins WHERE id = ?`)
    .get(id) as PluginRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function upsertPlugin(rec: PluginRecord): void {
  getDb()
    .prepare(
      `INSERT INTO plugins (id, version, manifest_json, state, source, source_path, installed_at)
       VALUES (@id, @version, @manifestJson, @state, @source, @sourcePath, @installedAt)
       ON CONFLICT(id) DO UPDATE SET
         version = excluded.version,
         manifest_json = excluded.manifest_json,
         state = excluded.state,
         source = excluded.source,
         source_path = excluded.source_path,
         installed_at = excluded.installed_at`,
    )
    .run(rec as unknown as Record<string, unknown>);
}

export function removePluginRecord(id: string): void {
  getDb().prepare(`DELETE FROM plugins WHERE id = ?`).run(id);
}

/**
 * workspace 级启停解析（spec 2026-10-21 §2）：行缺失 = 停用（scoped 语义；
 * 存量库由迁移 066 回填 enabled=1 保现状，新装/新 ws 走安装链单行写入）。
 */
export function isPluginEnabled(pluginId: string, workspaceId: string): boolean {
  const row = getDb()
    .prepare(`SELECT enabled FROM plugin_enablements WHERE workspace_id = ? AND plugin_id = ?`)
    .get(workspaceId, pluginId) as { enabled: number } | undefined;
  return row?.enabled === 1;
}

export function setPluginEnabled(pluginId: string, workspaceId: string, enabled: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO plugin_enablements (workspace_id, plugin_id, enabled) VALUES (?, ?, ?)
       ON CONFLICT(workspace_id, plugin_id) DO UPDATE SET enabled = excluded.enabled`,
    )
    .run(workspaceId, pluginId, enabled ? 1 : 0);
}
