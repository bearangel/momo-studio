// electron/src/main/resource/hub-install.ts
//
// hub MCP 安装/卸载与已装映射（spec §4.3）。
// P2.1 Task 3 直连翻转：install-config 端点已 404（死码移除），Smithery 安装改为
// 详情接口取 deploymentUrl → streamable_http 直连注册（免账号 A1）。配置字段按
// configSchema 的 x-from 元数据分流：'query' 拼进 URL query（encodeURIComponent），
// 其余（含缺省——实证样本均无 x-from，spec D5）进 headers。
// 记账走 installed_packages（item_id = `${source}:${slug}`），与 marketplace 同表
// 不同前缀，卸载互不误伤。
// 魔搭 remote 安装轨已于 P2.1 移除（registry 100% hosted 后放弃）；P3 若公开
// API 落地再评估。
//
// S1 注入防线（Task 2/4 审查传递）：slug 只进 encodeURIComponent 拼的 URL 与 DB 列，
// 禁止直接用作文件路径/本地标识（smithery 条目的 S1 只校验过 namespace 段——
// 完整 qualifiedName 含 @ 与 /，过不了 SLUG_PATTERN，故不在此复用该校验）。

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { registerMcpDefinition, listRegistered, deleteRegistered } from '../mcp/host-manager';
import type { McpConfigSchema } from '../mcp/types';
import { buildResourceId, type ResourceItem, type ResourceType } from './types';

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

/** Smithery hosted 条目直连安装：x-from 分流 → streamable_http 注册 + 记账。
 *  url 须为 https（与 registerMcpDefinition 远端校验同一防线，前置给出可读错误）。 */
export async function installSmitheryRemote(
  slug: string,
  url: string,
  config: Record<string, string>,
  schema?: JsonSchemaLike,
): Promise<void> {
  if (!url.startsWith('https://')) {
    throw new Error(`Smithery 服务器 ${slug} 的 deploymentUrl 非 https，拒绝直连：${url}`);
  }
  const headers: Record<string, string> = {};
  const queryParts: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (schema?.properties?.[key]?.['x-from'] === 'query') {
      queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    } else {
      headers[key] = value;
    }
  }
  const finalUrl =
    queryParts.length > 0 ? `${url}${url.includes('?') ? '&' : '?'}${queryParts.join('&')}` : url;
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
      id: buildResourceId(m.source, 'mcp', m.name),
      type: 'mcp' as const,
      source: m.source,
      slug: m.name,
      name: m.name.replace(/^@/, ''),
      description: m.transport === 'streamable_http' ? `远程 MCP（${m.url ?? ''}）` : `Smithery MCP（${m.command}）`,
      version: m.version,
      installed: true,
      installable: false,
      removable: true,
      custom: { installedAt: m.installedAt },
    }));
}

/** hub 卸载：删 mcp_definitions 行 + installed_packages 记账（幂等） */
export function uninstallHubMcp(source: 'smithery', slug: string): void {
  deleteRegisteredHubSafe(slug);
  const db = getDb();
  db.prepare('DELETE FROM installed_packages WHERE item_id = ?').run(`${source}:${slug}`);
}

/** hub 行允许直接删（deleteRegistered 对 marketplace 有保护，hub 无此约束） */
function deleteRegisteredHubSafe(name: string): void {
  // deleteRegistered 仅拦截 source='marketplace'，hub 行直接走删除
  deleteRegistered(name);
}
