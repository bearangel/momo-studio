// electron/src/main/resource/hub-install.ts
//
// hub 资源安装/卸载与已装映射（spec §4.3）。
//
// 两个 hub 源分工：
//   - smithery（国际注册表）：MCP 直连安装——详情 deploymentUrl → streamable_http
//     注册（见下方 installSmitheryRemote），P2.1 Task 3 起。
//   - momo-hub（自建节点，第五源）：目录项 → MarketplaceItem → installPackage
//     全链复用（spec §6.2），安装/卸载记账走 installed_packages，item_id 带
//     `hub:` 前缀（与 marketplace 同表不同前缀，卸载互不误伤）。
//
// P2.1 Task 3 直连翻转：install-config 端点已 404（死码移除），Smithery 安装改为
// 详情接口取 deploymentUrl → streamable_http 直连注册（免账号 A1）。配置字段按
// configSchema 的 x-from 元数据分流：'query' 拼进 URL query（encodeURIComponent），
// 其余（含缺省——实证样本均无 x-from，spec D5）进 headers。P2.2 Task 2 起
// 分流段单点收敛为 composeRemoteConfig（安装/编辑共用）。
// 魔搭 remote 安装轨已于 P2.1 移除（registry 100% hosted 后放弃）；P3 若公开
// API 落地再评估。
//
// S1 注入防线（Task 2/4 审查传递）：slug 只进 encodeURIComponent 拼的 URL 与 DB 列，
// 禁止直接用作文件路径/本地标识（smithery 条目的 S1 只校验过 namespace 段——
// 完整 qualifiedName 含 @ 与 /，过不了 SLUG_PATTERN，故不在此复用该校验）。

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { registerMcpDefinition, listRegistered, deleteRegistered, isAllowedRemoteUrl } from '../mcp/host-manager';
import { removeMcpRefsFromAgents } from '../agent/crud';
import type { McpConfigSchema } from '../mcp/types';
import { buildResourceId, type ResourceItem, type ResourceType } from './types';
import { fromCatalogItem } from './catalog-adapter';
import { installPackage, listInstalled, uninstallPackage } from '../marketplace/installer';
import { installPluginHubArchive } from '../plugin/hub-install';
import { uninstallPlugin } from '../plugin/installer';
import { getPlugin, listPlugins } from '../plugin/registry';
import { resolvePluginInstalledDir } from '../paths';
import {
  findHubMarketplaceItem,
  hubPackageItemId,
  HUB_ITEM_ID_PREFIX,
  listHubMarketplaceItems,
} from './hub/momo-hub';

const SMITHERY_BASE = 'https://registry.smithery.ai';

/**
 * Smithery configSchema 的消费面形状（详情接口 connections[].configSchema）。
 * P2.2 起单源化为 McpConfigSchema 别名（config_schema 列同形状，安装时原样落库）；
 * 响应可能携带更多（如 type: 'object'），运行时原样透传。
 */
export type JsonSchemaLike = McpConfigSchema;

/** 详情接口单条 connection（字段全部宽松可选以容错第三方响应） */
export interface SmitheryConnection {
  type?: string;
  deploymentUrl?: string;
  configSchema?: JsonSchemaLike;
}

/** GET /servers/{qualifiedName} 响应的消费面形状 */
export interface SmitheryServerDetail {
  connections: SmitheryConnection[];
}

/** resource:install smithery 分支两态返回（renderer types.d.ts 有镜像） */
export interface SmitheryInstallResult {
  needsConfig: boolean;
  schema?: JsonSchemaLike;
}

/** installed_packages 记账（item_id = `${source}:${slug}`，重复安装只留一行） */
function recordInstall(itemId: string, slug: string): void {
  const db = getDb();
  // 表 PK 是随机 id——INSERT OR REPLACE 在此永不冲突，挡不住 item_id 重复行。
  // 故先按 item_id 清旧账再插，保证幂等（brief 测试语义：重复安装只留一行）。
  db.prepare('DELETE FROM installed_packages WHERE item_id = ?').run(itemId);
  db.prepare(
    `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
     VALUES (?, ?, 'mcp', ?, '1.0.0', '', '')`,
  ).run(randomUUID(), itemId, slug);
}

/** 拉取 Smithery 服务器详情（deploymentUrl + configSchema 真源）。
 *  HTTP 非 2xx / 网络异常直接上抛（错误文案供 renderer 展示）。 */
export async function fetchSmitheryDetail(slug: string): Promise<SmitheryServerDetail> {
  const res = await fetch(`${SMITHERY_BASE}/servers/${encodeURIComponent(slug)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Smithery 详情获取失败：HTTP ${res.status}`);
  return (await res.json()) as SmitheryServerDetail;
}

/** 安装/编辑共用的 x-from 分流组装（spec §5.2）。空串值剔除（编辑链表单可选
 *  字段留空不产生占位项）；url scheme 与注册同防线（isAllowedRemoteUrl：http/https
 *  放行，http 供自建/本地测试）。Task 4 编辑链消费——返回形状变更
 *  需同步 compose-remote-config.test.ts 契约锁。 */
export function composeRemoteConfig(
  url: string,
  config: Record<string, string>,
  schema?: McpConfigSchema,
): { finalUrl: string; headers: Record<string, string> } {
  if (!isAllowedRemoteUrl(url)) {
    throw new Error(`远程 MCP url 必须以 http:// 或 https:// 开头: ${url}`);
  }
  const headers: Record<string, string> = {};
  const queryParts: string[] = [];
  for (const [key, value] of Object.entries(config).filter(([, v]) => v !== '')) {
    if (schema?.properties?.[key]?.['x-from'] === 'query') {
      queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    } else {
      headers[key] = value;
    }
  }
  const finalUrl =
    queryParts.length > 0
      ? `${url}${url.includes('?') ? '&' : '?'}${queryParts.join('&')}`
      : url;
  return { finalUrl, headers };
}

/** Smithery hosted 条目直连安装：x-from 分流 → streamable_http 注册 + 记账。
 *  分流/https 防线单点收敛在 composeRemoteConfig（编辑链 Task 4 复用）。 */
export async function installSmitheryRemote(
  slug: string,
  url: string,
  config: Record<string, string>,
  schema?: JsonSchemaLike,
): Promise<void> {
  const { finalUrl, headers } = composeRemoteConfig(url, config, schema);
  registerMcpDefinition({
    id: randomUUID(),
    name: slug,
    version: '1.0.0',
    transport: 'streamable_http',
    url: finalUrl,
    headers,
    configSchema: schema,
    command: '',
    args: [],
    source: 'smithery',
  });
  recordInstall(`smithery:${slug}`, slug);
  // query 可能含用户 config 值（如 API key），日志只记基础 url 避免泄漏
  logger.info('Smithery 远程 MCP 已安装', { slug, url: finalUrl.split('?')[0] });
}

/** mcp_definitions 中 hub 来源行 → ResourceItem（installed=true / removable=true） */
export function listHubInstalledResources(type?: ResourceType): ResourceItem[] {
  return listRegistered()
    .filter((m) => m.source === 'smithery' && (!type || type === 'mcp'))
    .map((m) => ({
      id: buildResourceId('smithery', 'mcp', m.name),
      type: 'mcp' as const,
      source: 'smithery' as const,
      slug: m.name,
      name: m.name.replace(/^@/, ''),
      description: m.transport === 'streamable_http' ? `远程 MCP（${m.url ?? ''}）` : `Smithery MCP（${m.command}）`,
      version: m.version,
      installed: true,
      installable: false,
      removable: true,
      custom: { installedAt: m.installedAt, transport: m.transport },
      // 组⑤：启停态透出（详情 toggle / 行「已禁用」标记消费）
      mcp: { enabled: m.enabled },
    }));
}

/**
 * momo-hub 目录项 → ResourceItem（source='hub'）——资源库第五源的并入面。
 *
 * 安装态口径与 marketplace 同款（catalog-adapter.fromCatalogItem）：
 * installed_packages.item_id = `hub:{slug}` 命中即视为已装 → installable /
 * removable 随之翻转。目录不可达（未接入 / 离线降级）时，已装但目录已无的条目
 * 走本地缓存形态兜底——installed_packages 行自带 slug/version/type，不依赖
 * 网络仍可见、可卸载。
 */
export async function listHubCatalogResources(type?: ResourceType): Promise<ResourceItem[]> {
  const items = await listHubMarketplaceItems(type);
  const mapped = items.map((item) => fromCatalogItem(item, 'hub'));
  // plugin 去重（消费面裁定）：已装插件的管理面 = plugins 表行（listPluginResourceRows
  // 的 custom-plugin-* 行，带启停/卸载 namespace）——hub 目录行在插件注册在场时
  // 隐藏，同物理插件不出现两张卡；注册行消失（幽灵账）时目录/兜底行恢复可见可卸
  const pluginIds = new Set(listPlugins().map((p) => p.id));
  const visible = mapped.filter((i) => !(i.type === 'plugin' && pluginIds.has(i.slug)));
  const catalogSlugs = new Set(visible.map((i) => i.slug));
  for (const row of listInstalled()) {
    if (!row.itemId.startsWith(HUB_ITEM_ID_PREFIX)) continue;
    const slug = row.itemId.slice(HUB_ITEM_ID_PREFIX.length);
    if (catalogSlugs.has(slug)) continue;
    if (
      row.itemType !== 'agent' &&
      row.itemType !== 'mcp' &&
      row.itemType !== 'skill' &&
      row.itemType !== 'plugin'
    ) {
      continue;
    }
    if (row.itemType === 'plugin' && pluginIds.has(slug)) continue;
    visible.push({
      id: buildResourceId('hub', row.itemType, slug),
      type: row.itemType,
      source: 'hub',
      slug,
      name: slug,
      description: '已从 momo-hub 安装（当前目录中已无此条目）',
      version: row.version,
      installed: true,
      installable: false,
      removable: true,
    });
  }
  return visible;
}

/**
 * momo-hub 条目安装：目录查项（按 type + slug）→ 分型安装链。
 *   - agent / mcp / skill：installPackage 全链（marketplace 缓存链，spec §6.2）
 *   - plugin：plugin 域注册链（installPluginHubArchive——PluginRecord 落库 +
 *     组件激活 + installed 目录落位，与本地 zip 安装完全等价）+ installed_packages
 *     记账（item_type='plugin'，页签已装态判定源）
 * 版本取目录当前版本（meta.version，非 semver 比较——更新语义裁定见 T14）。
 * 目录查不到 → 人话错误（未接入 / 已下架 / slug 拼错）。
 */
export interface InstallHubOptions {
  /** 应用版本（plugin 链 minAppVersion 闸消费；缺省跳过版本闸） */
  appVersion?: string;
  /** 安装作用域工作空间（plugin 链 enablement 单行落此 ws；缺省报错——与
   *  本地安装同语义：无作用域不装） */
  workspaceId?: string;
}

export async function installHubPackage(
  type: ResourceType,
  slug: string,
  opts?: InstallHubOptions,
): Promise<{ cachePath: string }> {
  const item = await findHubMarketplaceItem(type, slug);
  if (!item) {
    throw new Error(
      `momo-hub 目录中未找到 ${type} 条目「${slug}」（可能尚未接入 hub、hub 离线或该条目已下架）`,
    );
  }
  if (item.type === 'plugin') {
    const rec = await installPluginHubArchive(
      item,
      opts?.appVersion ?? '999.0.0',
      opts?.workspaceId ?? '',
    );
    // 记账：cache_path 指向真实 installed 目录（信息性——卸载走 plugin 级联，
    // 不经 marketplace 缓存链的 cache_path 删除语义）。置换旧账只清 plugin 行
    //（T15a-F1：`hub:{slug}` 不是跨类型唯一键，同 slug 的 agent/skill/mcp
    // 记账不得被重装连带抹掉）
    const db = getDb();
    db.prepare(
      "DELETE FROM installed_packages WHERE item_id = ? AND item_type = 'plugin'",
    ).run(hubPackageItemId(slug));
    db.prepare(
      `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
       VALUES (?, ?, 'plugin', ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      hubPackageItemId(slug),
      slug,
      rec.version,
      resolvePluginInstalledDir(rec.id, rec.version),
      item.checksum,
    );
    return { cachePath: resolvePluginInstalledDir(rec.id, rec.version) };
  }
  return installPackage(item);
}

/**
 * momo-hub 已装包卸载（幂等）：plugin 项级联 plugin 域卸载链（PluginRecord /
 * 目录 / MCP / 记账全清）；其余走 marketplace 缓存链卸载。
 * type 由调用方上下文透传（T15a-F1）：`hub:{slug}` 不是跨类型唯一键，按 DB 行
 * 反查路由会在 agent 与插件同 slug 时错删另一方——资源库删除入口手里就有
 * item.type，路由目标用当前上下文而非账表碰运气。
 */
export function uninstallHubPackage(type: ResourceType, slug: string): void {
  // 记账 item_id = `hub:{slug}`（hubPackageItemId 单点前缀）——传 ResourceItem.id
  // 会查无此行 → 静默 no-op（marketplace 同款陷阱，见 ipc.handlers delete 分支）
  if (type === 'plugin') {
    // 插件行在场 → plugin 级联（uninstallPlugin 内部同删记账，keepData=true——
    // 数据销毁须经插件设置页显式选择，资源页一键卸载保守保留）；
    // 插件行已消失（幽灵账）→ 落到下方类型限定直删兜底
    if (getPlugin(slug)) {
      uninstallPlugin(slug, true);
      return;
    }
  }
  uninstallPackage(hubPackageItemId(slug), type);
}

/** hub 卸载：删 mcp_definitions 行 + 级联清理 agent 引用 + installed_packages 记账（幂等） */
export function uninstallHubMcp(source: 'smithery', slug: string): void {
  deleteRegisteredHubSafe(slug);
  // P2.2 Task 5：删行成功后级联清理 agent 侧引用（删行失败上抛时不到这里；
  // 级联内部尽力而为，失败不阻断卸载）
  const cleaned = removeMcpRefsFromAgents(slug);
  if (cleaned.length > 0) {
    logger.info('卸载级联清理 MCP 引用', { name: slug, agents: cleaned });
  }
  const db = getDb();
  db.prepare('DELETE FROM installed_packages WHERE item_id = ?').run(`${source}:${slug}`);
}

/** hub 行允许直接删（deleteRegistered 对 marketplace 有保护，hub 无此约束） */
function deleteRegisteredHubSafe(name: string): void {
  // deleteRegistered 仅拦截 source='marketplace'，hub 行直接走删除
  deleteRegistered(name);
}
