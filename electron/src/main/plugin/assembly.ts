// electron/src/main/plugin/assembly.ts
//
// 插件装配计算（spec §4.2）：启用插件（workspace 级）→ 子进程装配快照。
// buildSpawnOpts 在 spawn 时调用本模块——产物即「定型快照」，天然继承
// spec §3.3 冻结语义（跑动会话不受后续启停影响）。
import fs from 'node:fs';
import path from 'node:path';
import { listPlugins, isPluginEnabled } from './registry';
import { resolvePluginInstalledDir, resolvePluginDataDir } from '../paths';
import type { PluginRecord } from './types';
import type { PluginToolRef } from '../agent/runtime-config';
import { readPluginConfigJson, sensitiveOverlaySync } from './config-store';
import { pluginUsesWorkspaceScope } from './service-manager';
import { getDb } from '../storage/db';

/** 插件根目录：zip=installed 副本 / dev=源目录；missing 态或 dev 目录消失 → null */
export function resolvePluginRoot(rec: PluginRecord): string | null {
  if (rec.state === 'missing') return null;
  if (rec.source === 'dev') {
    return rec.sourcePath && fs.existsSync(rec.sourcePath) ? rec.sourcePath : null;
  }
  return resolvePluginInstalledDir(rec.id, rec.version);
}

interface ResolvedPlugin {
  rec: PluginRecord;
  root: string;
  manifest: {
    components?: Record<string, string | undefined>;
    [key: string]: unknown;
  };
}

function enabledPlugins(workspaceId: string): ResolvedPlugin[] {
  const out: ResolvedPlugin[] = [];
  for (const rec of listPlugins()) {
    if (!isPluginEnabled(rec.id, workspaceId)) continue;
    const root = resolvePluginRoot(rec);
    if (root === null) continue;
    let manifest: ResolvedPlugin['manifest'];
    try {
      manifest = JSON.parse(rec.manifestJson) as ResolvedPlugin['manifest'];
    } catch {
      continue; // 坏 manifest 行跳过（P1 resources.ts 同款降级）
    }
    out.push({ rec, root, manifest });
  }
  return out;
}

/** 启用插件的工具装配快照（components.tools 顶层 .js，非递归）。
 *  工作空间维度 v1.1（spec §4.2/§4.4）：ref 附带工作区上下文（id + directoryPath，
 *  workspaces 行缺失时 undefined——存量容错）；multi 插件的 config 合并 workspace 层 */
export function buildPluginToolRefs(workspaceId: string): PluginToolRef[] {
  const wsRow = getDb()
    .prepare('SELECT id, directory_path FROM workspaces WHERE id = ?')
    .get(workspaceId) as { id: string; directory_path: string } | undefined;
  const workspace = wsRow ? { id: wsRow.id, directoryPath: wsRow.directory_path } : undefined;
  return enabledPlugins(workspaceId).flatMap(({ rec, root, manifest }) => {
    const toolsDirRel = manifest.components?.tools;
    if (typeof toolsDirRel !== 'string') return [];
    const toolsDir = path.resolve(root, toolsDirRel);
    let modulePaths: string[] = [];
    try {
      modulePaths = fs
        .readdirSync(toolsDir)
        .filter((f) => f.endsWith('.js'))
        .sort()
        .map((f) => path.join(toolsDir, f));
    } catch {
      return [];
    }
    const dataDir = resolvePluginDataDir(rec.id);
    const multi = pluginUsesWorkspaceScope(rec);
    return [
      {
        pluginId: rec.id,
        rootDir: root,
        modulePaths,
        dataDir,
        config: {
          ...readPluginConfigJson(rec.id),
          ...(multi ? readPluginConfigJson(rec.id, workspaceId) : {}),
          ...sensitiveOverlaySync(rec.id),
        },
        workspace,
      },
    ];
  });
}

/** 全部 active 插件贡献的 skills（资源面列举用——无工作空间维度，全量） */
export function listAllPluginSkills(): Array<{ slug: string; cachePath: string; pluginId: string }> {
  return listPlugins()
    .filter((rec) => rec.state === 'active')
    .flatMap((rec) => {
      const root = resolvePluginRoot(rec);
      const rel = rec.manifestJson ? (JSON.parse(rec.manifestJson) as { components?: { skills?: string } }).components?.skills : undefined;
      if (!root || typeof rel !== 'string') return [];
      const dir = path.resolve(root, rel);
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
          .map((e) => ({ slug: e.name, cachePath: path.join(dir, e.name), pluginId: rec.id }));
      } catch {
        return [];
      }
    });
}

/** 启用插件的 skill refs（零复制：cachePath 直指插件目录，SkillRegistry 接受任意绝对路径） */
export function buildPluginSkillRefs(
  workspaceId: string,
): Array<{ slug: string; cachePath: string }> {
  return enabledPlugins(workspaceId).flatMap(({ root, manifest }) => {
    const skillsDirRel = manifest.components?.skills;
    if (typeof skillsDirRel !== 'string') return [];
    const skillsDir = path.resolve(root, skillsDirRel);
    try {
      return fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md')))
        .map((e) => ({ slug: e.name, cachePath: path.join(skillsDir, e.name) }));
    } catch {
      return [];
    }
  });
}

interface McpFileShape {
  servers?: Record<string, unknown>;
}

/** mcp.json 解析（形状不对/坏 JSON → 空集；条目校验在 mcp-sync 注册时做） */
function readMcpServerNames(root: string, rel: string | undefined): string[] {
  if (typeof rel !== 'string') return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(root, rel), 'utf-8')) as McpFileShape;
    if (typeof parsed !== 'object' || parsed === null) return [];
    return Object.keys(parsed.servers ?? {});
  } catch {
    return [];
  }
}

/** 启用插件贡献的 MCP server 名集合 */
export function buildPluginMcpNames(workspaceId: string): string[] {
  return enabledPlugins(workspaceId).flatMap(({ root, manifest }) =>
    readMcpServerNames(root, manifest.components?.mcp),
  );
}

/** 过滤禁用插件贡献的 MCP 名（spawn 侧在 filterEnabledMcps 之后追加调用） */
export function filterDisabledPluginMcps(names: string[], workspaceId: string): string[] {
  const disabled = new Set<string>();
  for (const rec of listPlugins()) {
    if (isPluginEnabled(rec.id, workspaceId)) continue;
    const root = resolvePluginRoot(rec);
    if (root === null) continue;
    let manifest: ResolvedPlugin['manifest'];
    try {
      manifest = JSON.parse(rec.manifestJson) as ResolvedPlugin['manifest'];
    } catch {
      continue;
    }
    for (const n of readMcpServerNames(root, manifest.components?.mcp)) disabled.add(n);
  }
  return names.filter((n) => !disabled.has(n));
}


/** 启用插件中是否有 hooks 组件（spawn 快照——runtime 侧零往返短路依据） */
export function hasPluginHooks(workspaceId: string): boolean {
  return enabledPlugins(workspaceId).some(({ manifest }) =>
    typeof manifest.components?.hooks === 'string',
  );
}
