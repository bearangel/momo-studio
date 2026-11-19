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


/** 工具全名匹配：精确名或 plugin:<id>/* 组模式（与 deniedTools 同款语义）。
 *  实体迁至 agent/tools/shared/plugin-ref（子进程 loader 共消费——两侧匹配
 *  语义单一真相源）；此处 re-export 保既有 importer 不动。 */
export { toolRefMatches } from '../agent/tools/shared/plugin-ref';
import { toolRefMatches } from '../agent/tools/shared/plugin-ref';

/**
 * 白名单过滤（spec 2026-10-21 §6）：授权集（组/精确）内且不被黑名单剔除的
 * 模块才进装配快照——「可见性 = 装配面」的授权化落地；modulePaths 全滤空
 * 的 ref 丢弃。
 *
 * 2026-11-19 口径分裂修复：匹配键从模块文件 basename 改为模块声明的工具名
 * （moduleToolNames，modulePath → getDefs 短名集合）。用户实证 db-pro
 * （单文件 tools/index.js 导出 11 工具）：授权/校验/UI 域全部用工具名
 * （plugin:db-pro/query），旧实现用文件名（plugin:db-pro/index）匹配——
 * 精确授权永不命中，模块整体被剔除。模块准入 = 任一工具名过授权且不撞
 * 黑名单；map 缺项（模块实例化失败的坏模块）回退 basename 旧语义。
 * 逐工具剔除由子进程 loader 按 grantedPluginTools 完成（单文件多工具防粒度放大）。
 */
export function filterPluginToolRefsByGrant(
  refs: PluginToolRef[],
  grants: string[],
  denied: string[],
  moduleToolNames?: Map<string, { pluginId: string; names: string[] }>,
): PluginToolRef[] {
  const out: PluginToolRef[] = [];
  for (const ref of refs) {
    const modulePaths = ref.modulePaths.filter((mp) => {
      const entry = moduleToolNames?.get(mp);
      // map 缺项（坏模块）回退 basename 旧语义；条目 pluginId 与 ref 不一致时以 ref 为准
      const pluginId = entry?.pluginId ?? ref.pluginId;
      const shortNames = entry?.names ?? [path.basename(mp, '.js')];
      return shortNames.some((short) => {
        const fullName = `plugin:${pluginId}/${short}`;
        return toolRefMatches(fullName, grants) && !toolRefMatches(fullName, denied);
      });
    });
    if (modulePaths.length === 0) continue;
    out.push({ ...ref, modulePaths });
  }
  return out;
}

/** 启用插件中是否有 hooks 组件（spawn 快照——runtime 侧零往返短路依据） */
export function hasPluginHooks(workspaceId: string): boolean {
  return enabledPlugins(workspaceId).some(({ manifest }) =>
    typeof manifest.components?.hooks === 'string',
  );
}
