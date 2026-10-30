// electron/src/main/resource/plugin-dedup.ts
//
// M5.1 插件×本地副本去重（spec 2026-10-30 §1.1/§1.3，RC1）：
//
//   - dedupePluginLocalCopies：listResources 出口归并（installed 收窄同层）——
//     同 type+slug 插件行在场时 custom 本地副本行不输出。隐藏非删除（直查源
//     仍在，一键清理才真删）；id 体系不变。
//   - scanPluginDupIssues：库页提示条数据源（resource:pluginDupScan）——
//     「插件已提供同名的本地副本」清单。
//   - cleanupPluginDups：一键清理（resource:pluginDupCleanup）——skill=删 fs
//     目录+.sha256 标记；mcp/agent=删 DB custom 行；逐条删除前重扫描校验，
//     失败续删逐条报错不中断。仅此入口删除（禁自动删，spec §4 非目标）。
//
// 归并口径（spec §1.1 裁定）：
//   - skill：fs 副本（.sha256 标记目录）× 插件 skills 目录扫描（slug 对 slug）
//   - mcp：custom mcp_definitions 同名 × 插件自带 MCP（source='plugin' 行）
//   - agent：custom def 同 def.slug × 插件 agent def（source='plugin'）——
//     注意 ResourceItem.slug 对 agent 是 def.id（UUID），语义 slug（def.slug）
//     不在 item 上，须经 agent_definitions 读映射
//   - builtin × custom / marketplace × custom 不归并（fork 语义与罕见并存，
//     spec 明言不动——负例测试锁）
import { logger } from '../logger';
import { listAllPluginSkills } from '../plugin/assembly';
import { emitPluginEvent } from '../plugin/event-sources';
import { listAgentDefinitions } from '../agent/agent-queries';
import { deleteDefinition, removeMcpRefsFromAgents } from '../agent/crud';
import { listRegistered, deleteRegistered } from '../mcp/host-manager';
import { isBundleInstalled, uninstallMcpBundle } from '../mcp/bundle-import';
import { broadcastSessionListChanged } from '../im/session-service';
import { listInstalled as listInstalledSkills, deleteCustomSkill } from '../skill/zip-uploader';
import { buildResourceId, type ResourceItem } from './types';

/** 归并覆盖的三类型（plugin 资源行本身无副本概念，不参与） */
export type DupType = 'skill' | 'mcp' | 'agent';

/** 插件提供的语义 slug 清单（type → slug → 提供它的插件 id） */
function collectPluginProvided(): Map<DupType, Map<string, string>> {
  const out = new Map<DupType, Map<string, string>>([
    ['skill', new Map()],
    ['mcp', new Map()],
    ['agent', new Map()],
  ]);
  for (const s of listAllPluginSkills()) {
    out.get('skill')!.set(s.slug, s.pluginId);
  }
  for (const m of listRegistered()) {
    if (m.source === 'plugin' && m.pluginId) out.get('mcp')!.set(m.name, m.pluginId);
  }
  // plugin agent def.id 形如 plugin:<pluginId>:<slug>（agent-sync 落库约定）
  for (const d of listAgentDefinitions()) {
    if (d.source !== 'plugin') continue;
    const pluginId = d.id.split(':')[1] ?? '';
    if (pluginId !== '') out.get('agent')!.set(d.slug, pluginId);
  }
  return out;
}

/**
 * 插件优先归并：插件行在场的同 type+slug custom 行不输出（隐藏非删除）。
 * skill/mcp 直接用合并面里 source='plugin' 行的 slug；agent 的语义 slug 是
 * def.slug（不在 ResourceItem 上），读 agent_definitions 映射——DB 读失败
 * （未初始化等）只跳过 agent 归并并留痕，skill/mcp 不受影响。
 */
export function dedupePluginLocalCopies(items: ResourceItem[]): ResourceItem[] {
  const pluginSkillSlugs = new Set(
    items.filter((i) => i.source === 'plugin' && i.type === 'skill').map((i) => i.slug),
  );
  const pluginMcpNames = new Set(
    items.filter((i) => i.source === 'plugin' && i.type === 'mcp').map((i) => i.slug),
  );
  let pluginAgentSlugs: Set<string> | null = null;
  let customDefSlugById: Map<string, string> | null = null;
  // 只有合并面存在 custom/plugin agent 行才需要 def.slug 映射（负例：纯 builtin
  // agent 页不触发 DB 读）
  if (items.some((i) => i.type === 'agent' && (i.source === 'custom' || i.source === 'plugin'))) {
    try {
      const defs = listAgentDefinitions();
      pluginAgentSlugs = new Set(defs.filter((d) => d.source === 'plugin').map((d) => d.slug));
      customDefSlugById = new Map(defs.filter((d) => d.source === 'custom').map((d) => [d.id, d.slug]));
    } catch (err) {
      logger.warn('插件优先归并：agent_definitions 读取失败，agent 类型跳过归并', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return items.filter((i) => {
    if (i.source !== 'custom') return true; // 只归并 custom 行；builtin/marketplace 不动
    if (i.type === 'skill' && pluginSkillSlugs.has(i.slug)) return false;
    if (i.type === 'mcp' && pluginMcpNames.has(i.slug)) return false;
    if (i.type === 'agent' && pluginAgentSlugs !== null && customDefSlugById !== null) {
      const defSlug = customDefSlugById.get(i.slug);
      if (defSlug !== undefined && pluginAgentSlugs.has(defSlug)) return false;
    }
    return true;
  });
}

/** 提示条/清理入参的重复项形状（renderer types.d.ts PluginDupIssue 镜像） */
export interface PluginDupIssue {
  type: DupType;
  /** custom 行资源 slug（skill=slug / mcp=注册名 / agent=def.id）——清理入参键 */
  slug: string;
  /** custom 行展示名（提示条计数外的逐条核对用） */
  name: string;
  /** 提供同名能力的插件 id */
  pluginId: string;
}

/** 「插件已提供同名的本地副本」清单（resource:pluginDupScan 返回） */
export function scanPluginDupIssues(): PluginDupIssue[] {
  const provided = collectPluginProvided();
  const issues: PluginDupIssue[] = [];
  for (const s of listInstalledSkills()) {
    if (s.source !== 'custom') continue;
    const pluginId = provided.get('skill')!.get(s.slug);
    if (pluginId !== undefined) {
      issues.push({ type: 'skill', slug: s.slug, name: s.name, pluginId });
    }
  }
  for (const m of listRegistered()) {
    if (m.source !== 'custom') continue;
    const pluginId = provided.get('mcp')!.get(m.name);
    if (pluginId !== undefined) {
      issues.push({ type: 'mcp', slug: m.name, name: m.name, pluginId });
    }
  }
  for (const d of listAgentDefinitions()) {
    if (d.source !== 'custom') continue;
    const pluginId = provided.get('agent')!.get(d.slug);
    if (pluginId !== undefined) {
      issues.push({ type: 'agent', slug: d.id, name: d.name, pluginId });
    }
  }
  return issues;
}

/** 一键清理入参（type+slug 与 PluginDupIssue 同键） */
export interface PluginDupTarget {
  type: DupType;
  slug: string;
}

/** 一键清理结果：逐条报错不中断（部分失败续删，spec §1.1） */
export interface PluginDupCleanupResult {
  deleted: Array<PluginDupTarget>;
  failures: Array<PluginDupTarget & { reason: string }>;
}

/**
 * 一键清理插件重复的本地副本（resource:pluginDupCleanup）。逐条**重扫描校验**
 * 后才删——不信任 renderer 传入的清单（行可能已被删/不再重复）；非重复项记
 * failure 不动数据。删除实现与 resource:delete 的 custom 分支同款级联：
 *   - skill：deleteCustomSkill（fs 目录 + .sha256 标记）
 *   - mcp：bundle 记账行在场走 bundle 卸载，否则 deleteRegistered + agent 引用级联
 *   - agent：deleteDefinition（运行实例停机 + 成员/团队级联）+ 会话列表刷新广播
 */
export async function cleanupPluginDups(targets: PluginDupTarget[]): Promise<PluginDupCleanupResult> {
  const live = new Map(scanPluginDupIssues().map((i) => [`${i.type}:${i.slug}`, i]));
  const deleted: Array<PluginDupTarget> = [];
  const failures: Array<PluginDupTarget & { reason: string }> = [];
  for (const t of targets) {
    if (!live.has(`${t.type}:${t.slug}`)) {
      failures.push({ ...t, reason: '已不是插件重复项（可能已被删除）' });
      continue;
    }
    try {
      if (t.type === 'skill') {
        deleteCustomSkill(t.slug);
      } else if (t.type === 'mcp') {
        if (isBundleInstalled(t.slug)) {
          uninstallMcpBundle(t.slug);
        } else {
          deleteRegistered(t.slug);
          const cleaned = removeMcpRefsFromAgents(t.slug);
          if (cleaned.length > 0) {
            logger.info('一键清理级联清理 MCP 引用', { name: t.slug, agents: cleaned });
          }
        }
      } else {
        await deleteDefinition(t.slug);
        broadcastSessionListChanged();
      }
      deleted.push(t);
      emitPluginEvent('resourceRemoved', { id: buildResourceId('custom', t.type, t.slug) });
    } catch (err) {
      failures.push({ ...t, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { deleted, failures };
}
