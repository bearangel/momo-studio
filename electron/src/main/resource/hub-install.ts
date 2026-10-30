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
import fs from 'node:fs';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { registerMcpDefinition, listRegistered, deleteRegistered, isAllowedRemoteUrl } from '../mcp/host-manager';
import { removeMcpRefsFromAgents } from '../agent/crud';
import type { McpConfigSchema } from '../mcp/types';
import { buildResourceId, type ResourceItem, type ResourceType } from './types';
import { fromCatalogItem } from './catalog-adapter';
import { installPackage, listInstalled, uninstallPackage, type InstallPhaseListener } from '../marketplace/installer';
import { installPluginHubArchive } from '../plugin/hub-install';
import { uninstallPlugin } from '../plugin/installer';
import { getPlugin, listPlugins } from '../plugin/registry';
import { resolvePluginInstalledDir } from '../paths';
import {
  findHubMarketplaceItem,
  hubPackageItemId,
  HUB_ITEM_ID_PREFIX,
  listHubMarketplaceItems,
  resolveHubContext,
} from './hub/momo-hub';
import { assertNoLocalSlugConflict } from './hub/ownership';
import { compareVersions } from './version-compare';

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
    // M5.2：发布记账（cachePath='') 不是安装——不得产出「已装」兜底卡
    if (row.cachePath === '') continue;
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
      // 兜底行无目录元数据，installedVersion = version = 记账版本（D7 锚点恒在场）
      installedVersion: row.version,
      installed: true,
      installable: false,
      removable: true,
    });
  }
  return visible;
}

/**
 * momo-hub 条目安装：目录查项（按 type + slug，fresh 载入——D3-1/O1-1）→
 * 已装 semver 判定（D3-2）→ 分型安装链。
 *   - agent / mcp / skill：installPackage 全链（marketplace 缓存链，spec §6.2）
 *   - plugin：plugin 域注册链（installPluginHubArchive——PluginRecord 落库 +
 *     组件激活 + installed 目录落位，与本地 zip 安装完全等价）+ installed_packages
 *     记账（item_type='plugin'，页签已装态判定源）
 * 版本取 fresh 目录 latest（hub v0.1.5 起 = versions 全集 semver max）；target
 * ≤ 已装记账版本（compareVersions）时如实返回 alreadyLatest 零动作——不进
 * installer 的 `.installed` 幂等静默跳过路径（消除「回执成功但 DB 零变化」）。
 * 目录查不到 → 人话错误（未接入 / 已下架 / slug 拼错）。
 */
export interface InstallHubOptions {
  /** 应用版本（plugin 链 minAppVersion 闸消费；缺省跳过版本闸） */
  appVersion?: string;
  /** 安装作用域工作空间（plugin 链 enablement 单行落此 ws；缺省报错——与
   *  本地安装同语义：无作用域不装） */
  workspaceId?: string;
  /**
   * B13 钉死版本（镜像补装链专用——快照 manifest resources[].version 透传）：
   * 在场时目标版本 = 该值而非目录 latest。仅带 version 的 manifest 触发升级
   * （M2.3「不升级旧版」边界由此打开）；手动安装不传，latest 语义零变化。
   */
  pinnedVersion?: string;
}

/** installHubPackage 返回（renderer types.d.ts HubInstallResult 有镜像）：
 *  正常安装/更新 = { cachePath }；已装版本不低于 fresh 目录 latest =
 *  { cachePath, alreadyLatest: true, version: 已装版本 }——零动作如实回执。 */
export interface HubInstallOutcome {
  /** 安装落盘目录。**可能为空串**（发布记账回填行 cache_path=''）——
   *  消费方不得据此判断「已安装/存在」；存在性以 installed_packages 行为准。 */
  cachePath: string;
  /** true = 已是最新（target ≤ 已装，semver）——未发生下载/落账 */
  alreadyLatest?: boolean;
  /** alreadyLatest 在场时的已装版本（回执文案消费） */
  version?: string;
}

/**
 * 目录回落（stale）专用错误（M2.4 T1）：loadFresh 拉取失败、安装链只能用
 * cache/lastGood 快照判定时抛。语义：**无法确认 hub 上的最新版本**——不得
 * 冒充「已是最新」（版本可能已前进）也不得归因为「已下架」（目录不可达 ≠
 * 条目不存在）。renderer 既有 catch 直接展示 message（前缀「导入失败：」）；
 * 镜像补装链按 `instanceof` 识别并跳过该资源（不中止整体）。
 */
export class HubCatalogStaleError extends Error {
  override readonly name = 'HubCatalogStaleError';

  constructor(message: string) {
    super(message);
    // 保持原型链（ES5 目标下继承内置 Error 的常规修正；本项目 target 较新，
    // 此行冗余但零副作用——instanceof 判定在两侧运行时均可靠）
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 钉死版本不可得专用错误（M3.4 B13）：manifest 钉死的 version 在 hub 目录
 * versions 全集中不存在、或下载端点 404（版本行不存在/已撤回/blob 缺失）时抛。
 * 语义：**该 pinned 版本无法取得**——镜像补装链按 instanceof 识别并跳过该
 * 资源（记 unresolvedRefs，不中止整体——沿 HubCatalogStaleError 的软失败模式，
 * spec §2.3「404 → 记 unresolvedRefs 不中止」）。
 */
export class HubPinnedVersionUnavailableError extends Error {
  override readonly name = 'HubPinnedVersionUnavailableError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 本地 slug 冲突专用错误（M5.0 §7.5 源头拦截）：本地同 type+slug 自有实体
 * （custom/marketplace 源）在场且非 hub 装记账时抛——消「自定义 + hub 版」并存。
 * 手动安装链：rejection message 即人话（renderer toast 直出）；镜像补装链按
 * instanceof 识别并跳过该资源（软失败，记 unresolvedRefs 不中止整体——沿
 * stale/pinned 同款模式：目标已有本地版本是既成事实，静默保留 + 回执留痕）。
 */
export class HubSlugConflictError extends Error {
  override readonly name = 'HubSlugConflictError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * hub 下载链鉴权头（D1）：hub spec §3.1 三个资源端点全部 Bearer 鉴权，目录拉取
 * 与包下载必须同凭证。token 与目录源共用 resolveHubContext（生产 = keychain
 * deviceToken；测试注入 mock 上下文同缝生效）；无凭证（未接入 / keychain 空）
 * 返回 undefined——hub 侧 401 由下载错误路径人话报出。
 */
async function hubAuthHeaders(): Promise<Record<string, string> | undefined> {
  const ctx = await resolveHubContext();
  return ctx?.deviceToken ? { Authorization: `Bearer ${ctx.deviceToken}` } : undefined;
}

/**
 * 发布成功回填 hub 记账（M2.2 §2.1 四类泛化——plugin 专版先例 ba7cce8f 推广）：
 * 任一类型资源发布到 hub 成功后本地 installed_packages 写 `hub:{slug}` 行。
 * 两个消费面：镜像快照构建器 resources 段（记账反查携带）+ 目标节点
 * installResources 已装判定①（loadHubAccountingSet）——缺行 = 全新目标先装后落
 * 断链（M2.1 path2 实测：superpowers 类 skill 在全新 B 上 unresolved）。
 *
 * 与 installHubPackage 记账同构（DELETE+INSERT 幂等；升版单行更新不叠行）。
 * DELETE 带 item_type（T15a-F1）：`hub:{slug}` 不是跨类型唯一键，同 slug 的
 * 异类记账不得连带抹掉。cache_path 置空：发布场景本机已装形态各异（agent=定义
 * 表 / skill=缓存目录 / mcp=注册表 / plugin=installed 目录），与安装链的缓存
 * 目录语义不同——卸载链对空串是 no-op（rm '' 无操作），marketplace 已装行的
 * 缓存目录不被误伤。
 */
export function recordPublishAccounting(
  type: 'agent' | 'skill' | 'mcp' | 'plugin',
  slug: string,
  version: string,
  checksum: string,
): void {
  const db = getDb();
  // 孤儿缓存行守卫（M2.3 T5 件3）：旧 hub 安装行 cache_path 指向已删目录
  //（外部清缓存等）→ warn 留痕，行随置换自愈。回填不解引用旧 cache_path，
  // IPC 面无坏态消费点——故只观察不动作；置换有效路径产生的磁盘残渣为 M3 票
  //（卸载链补扫 hub 记账同 slug 的孤儿缓存目录）。
  const stale = db
    .prepare('SELECT cache_path FROM installed_packages WHERE item_id = ? AND item_type = ?')
    .all(hubPackageItemId(slug), type) as Array<{ cache_path: string }>;
  for (const row of stale) {
    if (row.cache_path !== '' && !fs.existsSync(row.cache_path)) {
      logger.warn('回填置换孤儿缓存行（cache_path 指向已删目录，随置换自愈）', {
        type,
        slug,
        cachePath: row.cache_path,
      });
    }
  }
  db.prepare('DELETE FROM installed_packages WHERE item_id = ? AND item_type = ?').run(
    hubPackageItemId(slug),
    type,
  );
  db.prepare(
    `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
     VALUES (?, ?, ?, ?, ?, '', ?)`,
  ).run(randomUUID(), hubPackageItemId(slug), type, slug, version, checksum);
}

/**
 * 发布侧安全壳（M2.2 §2.1 硬化——delta 终审 P3 并票）：记账失败不翻转发布回执。
 * hub 上传已成功，回填缺行只影响下次镜像的携带面，升版发布可自愈——
 * try/catch + warn，绝不把成功发布拖成失败。
 */
export function recordPublishAccountingSafe(
  type: 'agent' | 'skill' | 'mcp' | 'plugin',
  slug: string,
  version: string,
  checksum: string,
): void {
  try {
    recordPublishAccounting(type, slug, version, checksum);
  } catch (err) {
    logger.warn('发布记账回填失败（发布回执不受影响，下次升版发布可自愈）', {
      type,
      slug,
      version,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * hub 补装进度事件（M2.2 P2-7 契约——renderer types.d.ts / preload 有镜像）。
 * 消费面：worker 侧镜像补装可见性（大包如 56MB codegraph 下载期间 UI 有感知）；
 * 手动从资源库装 hub 包同样过此链（installHubPackage 单点发射）。
 */
export interface HubInstallProgressEvent {
  /** downloading（可多拍）→ extracting → done；失败终止拍 failed */
  stage: 'downloading' | 'extracting' | 'done' | 'failed';
  type: ResourceType;
  slug: string;
  /** stage='downloading' 字节拍在场：累计已收字节（512KB 增量节流） */
  receivedBytes?: number;
  /** stage='downloading' 在场：总量（Content-Length 可得时；可伪造头缺失/非法为 null） */
  totalBytes?: number | null;
  /** stage='failed' 在场：人话错误（消费面直接展示） */
  message?: string;
}

/** 进度事件通道名（preload onInstallProgress 同名——一义一名，改则两端同 commit） */
export const HUB_INSTALL_PROGRESS_CHANNEL = 'hub:installProgress';

/** 字节拍节流增量（512KB——56MB 包约 110 拍，IPC 不刷屏；下载起拍/阶段拍不受限） */
const PROGRESS_BYTE_DELTA = 512 * 1024;

const progressListeners = new Set<(e: HubInstallProgressEvent) => void>();

/** 订阅补装进度（进程内消费面/测试缝；广播路径不受影响）。返回解订阅函数。 */
export function onHubInstallProgress(listener: (e: HubInstallProgressEvent) => void): () => void {
  progressListeners.add(listener);
  return () => {
    progressListeners.delete(listener);
  };
}

/** 测试隔离：清空进程内订阅（防用例间监听泄漏；窗口广播路径不受影响） */
export function __clearHubInstallProgressListenersForTest(): void {
  progressListeners.clear();
}

/** 生产广播：全部窗口 webContents.send（panel-sync defaultBroadcast 同款懒加载——
 *  vitest 里 require('electron') 返回路径字符串，无窗口可推静默跳过） */
function broadcastProgressToWindows(e: HubInstallProgressEvent): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof import('electron') | string;
  if (typeof electron === 'string') return;
  for (const win of electron.BrowserWindow.getAllWindows()) {
    win.webContents.send(HUB_INSTALL_PROGRESS_CHANNEL, e);
  }
}

function emitProgress(e: HubInstallProgressEvent): void {
  for (const listener of progressListeners) listener(e);
  broadcastProgressToWindows(e);
}

/**
 * installHubPackage 专用阶段拍包装：downloading 字节拍按 512KB 增量节流
 * （起拍无字节信息时不节流）；extracting 恒直通。
 */
function makePhaseEmitter(type: ResourceType, slug: string): InstallPhaseListener {
  let lastEmittedBytes = -1;
  return (stage, info) => {
    if (stage === 'downloading' && typeof info?.receivedBytes === 'number') {
      if (lastEmittedBytes >= 0 && info.receivedBytes - lastEmittedBytes < PROGRESS_BYTE_DELTA) return;
      lastEmittedBytes = info.receivedBytes;
    }
    emitProgress({
      stage,
      type,
      slug,
      ...(typeof info?.receivedBytes === 'number' ? { receivedBytes: info.receivedBytes } : {}),
      ...(info && 'totalBytes' in info ? { totalBytes: info.totalBytes } : {}),
    });
  };
}

/**
 * 钉死版本探测（B13）：目录 meta 只带 latest 的 checksum——钉死版本的权威
 * 校验和在下载端点响应头 X-Checksum-Sha256（hub blob 内容寻址单源，逐版本）。
 * 轻量探测（headers 到手即取消 body，不落盘不耗流量）拿校验和；非 2xx /
 * 头缺失 / 网络异常 → null（调用方映射 HubPinnedVersionUnavailableError——
 * 「该 pinned 版本无法取得」软失败，与网络不可达的 stale 语义同走跳过路径）。
 */
async function probePinnedChecksum(
  pinnedUrl: string,
  headers: Record<string, string> | undefined,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(pinnedUrl, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
  // body 立即取消（undici 流式取消——只取响应头，不消费载荷）
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) return null;
  const checksum = res.headers.get('x-checksum-sha256');
  return checksum && checksum !== '' ? checksum : null;
}

export async function installHubPackage(
  type: ResourceType,
  slug: string,
  opts?: InstallHubOptions,
): Promise<HubInstallOutcome> {
  // M5.0 §7.5 源头拦截（先于目录拉取——冲突是本地事实，不依赖 hub 可达）：
  // 本地自有实体在场且非 hub 装记账 → 拒装。存量并存（custom + hub 装记账）
  // 不拦——更新合法，清理由扫描小票引导。
  assertNoLocalSlugConflict(type, slug);
  const { item, meta, stale, enrolled, hubUrl } = await findHubMarketplaceItem(type, slug);
  // 判定矩阵（M2.4 T1，顺序：enrolled → stale → item → 已装行 → cmp）：
  //   ① !enrolled            → 现状「未找到条目」文案（不改）
  //   ② enrolled && !stale && !item → 现状「可能已下架」文案（不改）
  //   ③ stale && !item       → 无法获取目录（不说「下架」——目录不可达 ≠ 条目消失）
  //   ④ stale && item && 未装 → 照常安装（回落快照的下载链是真闸门）
  //   ⑤ stale && item && 已装 && cmp<=0 → 无法确认最新版本（禁止 alreadyLatest）
  //   ⑥ !stale && item       → 现状（cmp<=0 alreadyLatest 如实 / cmp>0 装新版）
  // M3.4 B13：pinnedVersion 在场时 cmp 目标 = 钉死版本而非目录 latest——
  // 已装 ≥ pinned → alreadyLatest（零动作）；已装 < pinned → 升级到 pinned。
  // **镜像升级语义**：M2.3「不升级旧版」边界由此打开，且仅带 version 的 manifest
  // 触发（pinnedVersion 缺省 = 旧 latest 语义，全部存量行为零变化）。
  if (!enrolled) {
    throw new Error(
      `momo-hub 目录中未找到 ${type} 条目「${slug}」（可能尚未接入 hub、hub 离线或该条目已下架）`,
    );
  }
  if (stale && !item) {
    throw new HubCatalogStaleError(
      '无法连接到 momo-hub 获取最新目录（已装版本保持不变），请稍后重试',
    );
  }
  if (!item) {
    throw new Error(
      `momo-hub 目录中未找到 ${type} 条目「${slug}」（可能尚未接入 hub、hub 离线或该条目已下架）`,
    );
  }
  const pinned = opts?.pinnedVersion;
  const targetVersion = pinned ?? item.version;
  // 已装判定 semver 化（M2.3 T2 D3-2）：目标版本 ≤ 已装记账版本 →
  // 如实返回「已是最新」零动作（缺段容忍：'1.0' == '1.0.0' 同样命中，不重装）；
  // 乱序/旧目录低版本不降级；版本前进才继续走安装链。
  const installedRow = listInstalled().find(
    (p) => p.itemId === hubPackageItemId(slug) && p.itemType === type,
  );
  if (installedRow && compareVersions(targetVersion, installedRow.version) <= 0) {
    // ⑤ 回落快照的「同版」不可信：hub 上可能已有新版——如实报「无法确认」，
    // 不得返回 alreadyLatest（否则卡面「可更新」角标与回执文案互相矛盾）。
    // pinned 同守：目录回落时对已装 ≥ pinned 也不下结论，软失败留给镜像链跳过。
    if (stale) {
      throw new HubCatalogStaleError(
        '无法确认 momo-hub 上的最新版本（网络不可用），请稍后重试',
      );
    }
    return { cachePath: installedRow.cachePath, alreadyLatest: true, version: installedRow.version };
  }
  const headers = await hubAuthHeaders();
  // 钉死版本条目改写（B13）：version/downloadUrl/checksum 三点换为 pinned 口径——
  // versions 全集预检（版本行不存在 → 软失败错误）+ 下载端点探测拿逐版本权威
  // checksum（plugin 链强制 sha256 校验，目录 meta 的 latest checksum 不可用于旧版）。
  let installItem = item;
  if (pinned !== undefined && pinned !== item.version) {
    if (!meta?.versions.includes(pinned)) {
      throw new HubPinnedVersionUnavailableError(
        `momo-hub 目录中 ${type}「${slug}」无版本 ${pinned}（版本行不存在或已撤回），无法按快照钉死版本安装`,
      );
    }
    const pinnedUrl = `${hubUrl}/resources/${slug}/${pinned}/download`;
    const checksum = await probePinnedChecksum(pinnedUrl, headers);
    if (checksum === null) {
      throw new HubPinnedVersionUnavailableError(
        `momo-hub 资源「${slug}」版本 ${pinned} 下载不可得（404 或网络异常），无法按快照钉死版本安装`,
      );
    }
    installItem = { ...item, version: pinned, checksum, downloadUrl: pinnedUrl };
  }
  const onProgress = makePhaseEmitter(type, slug);
  try {
    if (installItem.type === 'plugin') {
      const rec = await installPluginHubArchive(
        installItem,
        opts?.appVersion ?? '999.0.0',
        opts?.workspaceId ?? '',
        headers,
        onProgress,
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
        installItem.checksum,
      );
      // done 拍在记账落库后（契约：done = 安装+记账全部完成）
      emitProgress({ stage: 'done', type, slug });
      return { cachePath: resolvePluginInstalledDir(rec.id, rec.version) };
    }
    const result = await installPackage(installItem, undefined, headers, onProgress);
    emitProgress({ stage: 'done', type, slug });
    return result;
  } catch (err) {
    // 钉死模式下的下载 404（探测后到下载之间的极窄竞态——版本行被撤等）：
    // 转软失败错误，镜像链据此跳过不中止（spec §2.3「下载 404 → 记 unresolvedRefs」）
    if (pinned !== undefined && err instanceof Error && /HTTP 404/.test(err.message)) {
      throw new HubPinnedVersionUnavailableError(
        `momo-hub 资源「${slug}」版本 ${pinned} 下载失败（404），无法按快照钉死版本安装`,
      );
    }
    // 失败终止拍：人话 message 随事件透传（worker 侧 UI 直接展示）；错误原样上抛
    emitProgress({
      stage: 'failed',
      type,
      slug,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
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
