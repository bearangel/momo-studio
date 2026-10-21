// electron/src/main/plugin/inventory.ts
//
// 插件明细组件清单（spec 2026-10-21 §9②）：MCP / 工具 / skill / agent / 面板 /
// service / config 七面只读展示。missing 态容错（各数组空，不 throw——坏一行
// 不崩明细）；「谁在用」反查不做（YAGNI）。
import { getPlugin } from './registry';
import { resolvePluginRoot, listAllPluginSkills } from './assembly';
import { listAssembledToolDefs } from './tool-catalog';
import { loadAndValidatePanels } from './panel-sync';
import { getDb } from '../storage/db';
import type { PluginRecord, PluginManifest } from './types';

export interface PluginDetail {
  pluginId: string;
  mcps: Array<{ name: string }>;
  tools: Array<{ fullName: string; description: string; pluginName: string }>;
  skills: Array<{ slug: string }>;
  agents: Array<{ id: string; name: string }>;
  panels: Array<{ panelId: string; title: string }>;
  service: boolean;
  config: boolean;
}

function manifestOf(rec: PluginRecord): PluginManifest | null {
  try {
    return JSON.parse(rec.manifestJson) as PluginManifest;
  } catch {
    return null;
  }
}

export function getPluginDetail(pluginId: string, workspaceId?: string): PluginDetail {
  const rec = getPlugin(pluginId);
  if (!rec) throw new Error(`插件不存在: ${pluginId}`);
  const root = resolvePluginRoot(rec);
  const manifest = manifestOf(rec);
  const db = getDb();

  const tools =
    root !== null
      ? listAssembledToolDefs(workspaceId ?? '')
          .filter((t) => t.pluginId === pluginId)
          .map((t) => ({ fullName: t.fullName, description: t.description, pluginName: t.pluginName }))
      : [];

  const skills = listAllPluginSkills()
    .filter((s) => s.pluginId === pluginId)
    .map((s) => ({ slug: s.slug }));

  const mcps = (
    db.prepare(`SELECT name FROM mcp_definitions WHERE plugin_id = ?`).all(pluginId) as Array<{
      name: string;
    }>
  ).map((m) => ({ name: m.name }));

  const agents = (
    db
      .prepare(`SELECT id, name FROM agent_definitions WHERE source = 'plugin' AND id LIKE ?`)
      .all(`plugin:${pluginId}:%`) as Array<{ id: string; name: string }>
  ).map((a) => ({ id: a.id, name: a.name }));

  let panels: Array<{ panelId: string; title: string }> = [];
  if (root !== null && manifest?.components?.panel) {
    try {
      panels = loadAndValidatePanels(rec).map((p) => ({ panelId: p.id, title: p.title }));
    } catch {
      panels = []; // panel.json 运行时损坏——明细容错空
    }
  }

  return {
    pluginId,
    mcps,
    tools,
    skills,
    agents,
    panels,
    service: typeof manifest?.components?.service === 'string' && root !== null,
    config: !!manifest?.config,
  };
}
