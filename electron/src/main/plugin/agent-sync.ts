// electron/src/main/plugin/agent-sync.ts
//
// 插件 agents 激活（spec §10 P2）：components.agents 下 YAML → agent_definitions
// 幂等落库（source='plugin'、id=plugin:<pluginId>:<slug>、workspaceId=NULL——
// 全局行复用 workspace 成员制启用流，范式同 builtin.ts）。
// 卸载级联：成员行 + 定义行单事务清理（跑动实例按快照跑完，语义同其他删除面）。
import fs from 'node:fs';
import path from 'node:path';
import { parseAgentManifestWithSuggestion } from '../agent/manifest-parser';
import { saveAgentDefinition } from '../agent/crud';
import type { AgentDefinition } from '../agent/types';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { resolvePluginRoot } from './assembly';
import type { PluginRecord } from './types';

interface PluginManifestShape {
  components?: { agents?: string };
}

/** 注册插件 agents（幂等 + 收敛：目录中已消失的 slug 行连带成员行清理——
 * dev 工作流「删 YAML→重载即生效」与 install/reload 共用本语义，审查 I3）。返回写入数。 */
export function registerPluginAgents(rec: PluginRecord): number {
  const root = resolvePluginRoot(rec);
  if (root === null) return 0;
  let manifest: PluginManifestShape;
  try {
    manifest = JSON.parse(rec.manifestJson) as PluginManifestShape;
  } catch {
    return 0;
  }
  const agentsRel = manifest.components?.agents;
  if (typeof agentsRel !== 'string') return 0;
  const dir = path.resolve(root, agentsRel);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  } catch {
    return 0;
  }
  const liveDefIds: string[] = [];
  const registered = registerAgentFiles(rec, dir, files, liveDefIds);
  pruneStaleAgentDefs(rec.id, liveDefIds);
  return registered;
}

function registerAgentFiles(
  rec: PluginRecord,
  dir: string,
  files: string[],
  liveDefIds: string[],
): number {
  let count = 0;
  for (const file of files) {
    try {
      const yamlContent = fs.readFileSync(path.join(dir, file), 'utf-8');
      const { def: parsedDef } = parseAgentManifestWithSuggestion(yamlContent);
      const def: AgentDefinition = {
        ...parsedDef,
        id: `plugin:${rec.id}:${parsedDef.slug}`,
        source: 'plugin',
        workspaceId: null,
        modelProviderId: null,
      };
      saveAgentDefinition(def);
      liveDefIds.push(def.id);
      count += 1;
    } catch (err) {
      logger.warn('插件 agent 解析失败（已跳过）', {
        pluginId: rec.id,
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return count;
}

/** 清理本插件下已不在目录中的幽灵定义行（含成员行）——substr 精确前缀匹配
 * （LIKE 的 _ 是单字符通配，会跨插件误删，审查 I2） */
function pruneStaleAgentDefs(pluginId: string, liveDefIds: string[]): void {
  const db = getDb();
  const prefix = `plugin:${pluginId}:`;
  const rows = db
    .prepare(`SELECT id FROM agent_definitions WHERE substr(id, 1, ?) = ?`)
    .all(prefix.length, prefix) as Array<{ id: string }>;
  for (const { id } of rows) {
    if (liveDefIds.includes(id)) continue;
    const instances = db
      .prepare(`SELECT instance_id FROM workspace_agent_members WHERE agent_definition_id = ?`)
      .all(id) as Array<{ instance_id: string }>;
    db.transaction(() => {
      if (instances.length > 0) {
        const ph = instances.map(() => '?').join(', ');
        db.prepare(
          `UPDATE workspaces SET default_agent_instance_id = NULL WHERE default_agent_instance_id IN (${ph})`,
        ).run(...instances.map((i) => i.instance_id));
      }
      db.prepare(`DELETE FROM workspace_agent_members WHERE agent_definition_id = ?`).run(id);
      db.prepare(`DELETE FROM agent_definitions WHERE id = ?`).run(id);
    })();
  }
}

/** 卸载级联：清该插件全部定义的成员行与定义行（单事务；no-op 安全）。
 * substr 精确前缀匹配——同 pruneStaleAgentDefs（审查 I2）。 */
export function removePluginAgents(pluginId: string): void {
  const db = getDb();
  const prefix = `plugin:${pluginId}:`;
  db.transaction(() => {
    const defs = db
      .prepare(`SELECT id FROM agent_definitions WHERE substr(id, 1, ?) = ?`)
      .all(prefix.length, prefix) as Array<{ id: string }>;
    for (const { id } of defs) {
      const instances = db
        .prepare(
          `SELECT instance_id FROM workspace_agent_members WHERE agent_definition_id = ?`,
        )
        .all(id) as Array<{ instance_id: string }>;
      if (instances.length > 0) {
        const ph = instances.map(() => '?').join(', ');
        db.prepare(
          `UPDATE workspaces SET default_agent_instance_id = NULL WHERE default_agent_instance_id IN (${ph})`,
        ).run(...instances.map((i) => i.instance_id));
      }
      db.prepare(`DELETE FROM workspace_agent_members WHERE agent_definition_id = ?`).run(id);
      db.prepare(`DELETE FROM agent_definitions WHERE id = ?`).run(id);
    }
  })();
}
