// electron/src/main/resource/hub/momo-hub.ts
//
// momo-hub provider——资源库第五源（spec M1 §6.1/§6.2，裁定 RM1-1/RM1-12）。
//
// 目录源：HTTP GET {hubUrl}/resources/catalog（Bearer deviceToken）→ 响应经
// protocol 包 validateHubCatalog 校验（结构校验单源于协议包，studio 不自造
// 第二份——裁定 RM1-1）→ HubResourceMeta 映射 MarketplaceItem（installPackage
// 原样复用，spec §6.2）。
//
// 缓存策略逐条对齐 marketplace/client.ts：成功 TTL 5min + 失败退避 60s +
// lastGood 直返 + 后台单飞刷新 + degraded 布尔透传（resource:getCatalogStatus
// 聚合返回 {source:'hub', degraded}）。
//
// 未接入引导态：hubGetStatus().configured === false → 空目录 + degraded=false +
// notEnrolled=true（零网络，renderer 显示「未接入 momo-hub」引导链到设置）；
// hub 在线但 catalog 401（token 失效）→ degraded=true（不静默空目录）。
//
// RM1-12（binding）：downloadUrl 一律以 studio 自身配置的 hubUrl 重写基址
// （路径部分保留 catalog 给的 /resources/{slug}/{version}/download）——不盲信
// catalog 的绝对地址（catalog 由发布方自报，其 host 不可信）。

import { validateHubCatalog, type HubCatalog, type HubResourceMeta } from '../../hub/protocol';
import { hubGetStatus } from '../../hub';
import { getDeviceToken } from '../../hub/creds';
import { logger } from '../../logger';
import { registerTrustedDownloadOrigin } from '../../marketplace/installer';
import type { MarketplaceItem } from '../../marketplace/types';
import { fromCatalogItem } from '../catalog-adapter';
import type { ResourceItem, ResourceType } from '../types';
import type { HubEntry, HubListResult, HubProvider } from './types';

/** 成功缓存 TTL（与 marketplace/client.ts 同档 5min） */
export const HUB_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

/** 失败退避窗口（与 marketplace/client.ts 同档 60s） */
export const HUB_CATALOG_FAILURE_BACKOFF_MS = 60 * 1000;

/** 单次请求超时（与 marketplace/client.ts 同档 3s，避免 UI 长时间卡住） */
const DEFAULT_TIMEOUT_MS = 3000;

/** hub 资源类型 → marketplace 可安装类型（plugin 自 T12 起接通安装链） */
export type HubMarketplaceType = 'agent' | 'mcp' | 'skill' | 'plugin';

/** 空目录（未接入 / 首拉失败且无 lastGood 时的占位） */
const EMPTY_CATALOG: HubCatalog = { version: '0', updatedAt: '', items: [] };

/** hub 上下文——studio 自身配置的 hub 基址 + device token */
export interface HubContext {
  /** hub 基址（studio 自身配置，已去尾斜杠） */
  hubUrl: string;
  /** device token（Bearer 鉴权；keychain 缺失时为 null——hub 返 401 → degraded） */
  deviceToken: string | null;
}

/** hub 上下文解析器（DI 缝——生产走 HubManager + keychain，测试注入本地 mock hub） */
export type HubContextResolver = () => Promise<HubContext | null>;

/** 一次目录加载的结果 */
export interface HubCatalogLoad {
  /** 校验通过的 hub 目录 */
  catalog: HubCatalog;
  /** hub 基址（downloadUrl 重写用；未接入时为 null） */
  hubUrl: string | null;
  /** 降级态（上次拉取失败且未恢复——退避中 / lastGood 为陈旧值） */
  degraded: boolean;
  /** 未接入引导态（hub 未配置——空目录 + degraded=false） */
  notEnrolled: boolean;
  /**
   * M2.4 R1：本次加载是否命中回落快照（仅 loadFresh() 失败时 true）。
   * 浏览链（load）与成功路径恒 false；此位不写退避、不置 degraded——
   * 只服务安装链的「失败如实化」判定（HubCatalogStaleError）。
   */
  stale: boolean;
}

export interface HubCatalogSourceOptions {
  /** 单次请求超时（默认 3s） */
  timeoutMs?: number;
}

export interface HubCatalogSource {
  load(): Promise<HubCatalogLoad>;
  /**
   * 强制 fresh 载入（安装/更新链消费——M2.3 T2，D3-1/O1-1 主修点）：
   * 绕 TTL/退避/lastGood 阻塞拉取最新目录；成功照常 recordSuccess 顺带治愈
   * 缓存；失败回落已知快照（cache/lastGood）且**不写退避与 degraded**——
   * 安装是用户动作，不因单次失败把浏览链打进零网络窗口（P2-9 退避零刷屏
   * 语义不破；回落的已知快照 downloadUrl 指向同 hub，下载链是真闸门）。
   */
  loadFresh(): Promise<HubCatalogLoad>;
  /** 当前是否降级（resource:getCatalogStatus 消费） */
  isDegraded(): boolean;
  /** 测试用：清缓存/退避/降级态 */
  resetForTest(): void;
  /** 测试用：成功缓存 TTL 整体前移 ms（模拟 TTL 过期，不伪造系统时钟） */
  rewindCacheForTest(ms: number): void;
  /** 测试用：失败退避截止时刻整体前移 ms（模拟退避窗口流逝） */
  rewindFailureBackoffForTest(ms: number): void;
}

/** hub 基址归一（去尾斜杠） */
function normalizeHubUrl(hubUrl: string): string {
  return hubUrl.trim().replace(/\/+$/, '');
}

/** 生产默认上下文解析：HubManager 配置 + keychain 凭证 */
async function defaultResolveHubContext(): Promise<HubContext | null> {
  const status = hubGetStatus();
  if (!status.configured || !status.hubUrl) return null;
  const deviceToken = await getDeviceToken();
  return { hubUrl: normalizeHubUrl(status.hubUrl), deviceToken };
}

/** 生效中的上下文解析器（生产 = HubManager + keychain；测试可注入 mock hub） */
let contextResolver: HubContextResolver = defaultResolveHubContext;

/**
 * 测试用：把默认目录源的上下文解析器换成注入的 mock（进程内 node:http mock hub），
 * 传 null 恢复生产解析器。切换即清缓存/退避/降级态——防上一用例的 catalog 串味。
 */
export function __setHubContextResolverForTest(resolver: HubContextResolver | null): void {
  contextResolver = resolver ?? defaultResolveHubContext;
  defaultSource.resetForTest();
}

/**
 * 当前生效的 hub 上下文（安装链 Bearer 凭证消费——D1）。
 * 与目录源共用同一解析器缝：生产 = HubManager + keychain；测试经
 * __setHubContextResolverForTest 注入的 mock 上下文对下载鉴权同样生效，
 * 保证「目录请求带 token、下载请求也带 token」同源不漂移。
 */
export function resolveHubContext(): Promise<HubContext | null> {
  return contextResolver();
}

/**
 * downloadUrl 基址重写（裁定 RM1-12）：路径部分保留 catalog 给的
 * /resources/{slug}/{version}/download，基址一律换成 studio 自身配置的 hubUrl
 * ——catalog 的 host 由发布方自报，不可信。
 */
export function rewriteDownloadUrl(catalogDownloadUrl: string, hubUrl: string): string {
  const base = normalizeHubUrl(hubUrl);
  let pathPart: string;
  try {
    const parsed = new URL(catalogDownloadUrl);
    pathPart = `${parsed.pathname}${parsed.search}`;
  } catch {
    pathPart = catalogDownloadUrl.startsWith('/') ? catalogDownloadUrl : `/${catalogDownloadUrl}`;
  }
  return `${base}${pathPart}`;
}

/** hub 已装包记账 item_id 前缀（installed_packages.item_id = `hub:{slug}`） */
export const HUB_ITEM_ID_PREFIX = 'hub:';

/**
 * hub 已装包的记账 item_id（installed_packages.item_id）——`hub:{slug}` 前缀
 * 是 hub 来源的唯一标记（零 schema 变更，spec §6.2）。单点真源：目录项 id
 * （toMarketplaceItem）、卸载查账（uninstallPackage）、已装态判定共用本函数，
 * 避免前缀散落各处漂移。
 */
export function hubPackageItemId(slug: string): string {
  return `${HUB_ITEM_ID_PREFIX}${slug}`;
}

/**
 * HubResourceMeta → MarketplaceItem（spec §6.2：installPackage 原样复用）。
 * versions 数组丢弃（studio 侧版本比较单源在 resource/version-compare.ts——
 * M2.3 T2 起安装链判定 semver 化，不再依赖数组时序语义；hub v0.1.5 起
 * versions 已是 semver 降序，原始数组经 listHubResourceMetas 透传）；
 * installCount 丢弃语义（spec §10：hub 无评分/安装计数）。
 */
export function toMarketplaceItem(meta: HubResourceMeta, hubUrl: string): MarketplaceItem {
  return {
    // item_id 前缀 'hub:'——零 schema 变更区分 hub 来源（spec §6.2）
    id: hubPackageItemId(meta.slug),
    type: meta.type as HubMarketplaceType,
    slug: meta.slug,
    name: meta.name,
    version: meta.version,
    author: meta.author,
    description: meta.description,
    readme: meta.readme,
    tags: [...meta.tags],
    category: meta.category,
    iconEmoji: meta.iconEmoji,
    // hub 恒为 unverified（私有仓无分级——协议包类型即如此定）
    verificationStatus: 'unverified',
    downloadUrl: rewriteDownloadUrl(meta.downloadUrl, hubUrl),
    checksum: meta.checksum,
    sizeBytes: meta.sizeBytes,
    installCount: 0,
  };
}

/** 协议四类全部可输出（plugin 自 T12 起接通——安装链走 plugin 域注册入口） */
function isMarketplaceType(type: string): type is HubMarketplaceType {
  return type === 'agent' || type === 'mcp' || type === 'skill' || type === 'plugin';
}

/**
 * 目录源实例——缓存/退避/单飞状态封在闭包里，每个实例互不干扰
 * （生产单例 + 测试注入实例并存，测试用例间零串味）。
 */
export function createHubCatalogSource(
  resolveContext: HubContextResolver,
  options: HubCatalogSourceOptions = {},
): HubCatalogSource {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let cache: { expiresAt: number; catalog: HubCatalog } | null = null;
  let failureBackoffUntil = 0;
  let lastGoodCatalog: HubCatalog | null = null;
  let inflightRefresh: Promise<void> | null = null;
  let degraded = false;

  async function fetchCatalog(ctx: HubContext): Promise<HubCatalog> {
    const url = `${ctx.hubUrl}/resources/catalog`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (ctx.deviceToken) headers.Authorization = `Bearer ${ctx.deviceToken}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`hub catalog 响应非 2xx：${res.status}`);
    const raw = (await res.json()) as unknown;
    const catalog = validateHubCatalog(raw);
    if (!catalog) throw new Error('hub catalog 结构非法');
    return catalog;
  }

  function recordSuccess(catalog: HubCatalog): void {
    cache = { expiresAt: Date.now() + HUB_CATALOG_CACHE_TTL_MS, catalog };
    lastGoodCatalog = catalog;
    failureBackoffUntil = 0;
    degraded = false;
  }

  function recordFailure(err: unknown): void {
    failureBackoffUntil = Date.now() + HUB_CATALOG_FAILURE_BACKOFF_MS;
    degraded = true;
    logger.warn('hub catalog 获取失败', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  /** 后台刷新（单飞）：成功建立 TTL 缓存 + 清退避；失败续退避 */
  function refreshInBackground(ctx: HubContext): void {
    if (inflightRefresh) return;
    const task = (async () => {
      try {
        recordSuccess(await fetchCatalog(ctx));
      } catch (err) {
        recordFailure(err);
      } finally {
        inflightRefresh = null;
      }
    })();
    inflightRefresh = task;
  }

  async function load(): Promise<HubCatalogLoad> {
    const ctx = await resolveContext();
    if (!ctx) {
      // 未接入引导态：空目录 + 零网络。degraded 必须在此复位——忘记接入
      // （hubForget → configured=false）后，isDegraded() 若仍挂着上次失败的
      // true，与 notEnrolled 分支输出的 degraded=false 两面结论相反（F1）。
      degraded = false;
      return {
        catalog: EMPTY_CATALOG,
        hubUrl: null,
        degraded: false,
        notEnrolled: true,
        stale: false,
      };
    }
    // hub origin 入 installer 信任集（配置变更后下次拉取即重新登记）
    registerTrustedDownloadOrigin(ctx.hubUrl);

    // TTL 命中——零网络
    if (cache && cache.expiresAt > Date.now()) {
      return {
        catalog: cache.catalog,
        hubUrl: ctx.hubUrl,
        degraded,
        notEnrolled: false,
        stale: false,
      };
    }
    // 退避窗口内零网络——直返 lastGood（无则空目录）
    if (failureBackoffUntil > Date.now()) {
      return {
        catalog: lastGoodCatalog ?? EMPTY_CATALOG,
        hubUrl: ctx.hubUrl,
        degraded: true,
        notEnrolled: false,
        stale: false,
      };
    }
    // 进程内首次（无任何已知结果）：阻塞式拉取——唯一允许阻塞调用方的路径
    const known = cache?.catalog ?? lastGoodCatalog;
    if (!known) {
      try {
        const catalog = await fetchCatalog(ctx);
        recordSuccess(catalog);
        return { catalog, hubUrl: ctx.hubUrl, degraded: false, notEnrolled: false, stale: false };
      } catch (err) {
        recordFailure(err);
        return {
          catalog: EMPTY_CATALOG,
          hubUrl: ctx.hubUrl,
          degraded: true,
          notEnrolled: false,
          stale: false,
        };
      }
    }
    // 已有已知结果（过期缓存 / lastGood）：直返旧值 + 后台单飞刷新
    refreshInBackground(ctx);
    return { catalog: known, hubUrl: ctx.hubUrl, degraded, notEnrolled: false, stale: false };
  }

  // 安装/更新链专用（M2.3 T2 D3-1/O1-1）：绕全部缓存语义阻塞拉取——目录快照
  // 陈旧时装旧版的两条实锤路径（更新停留 v1 / 全新安装取旧 meta）在此治愈。
  async function loadFresh(): Promise<HubCatalogLoad> {
    const ctx = await resolveContext();
    if (!ctx) {
      return {
        catalog: EMPTY_CATALOG,
        hubUrl: null,
        degraded: false,
        notEnrolled: true,
        stale: false,
      };
    }
    registerTrustedDownloadOrigin(ctx.hubUrl);
    try {
      const catalog = await fetchCatalog(ctx);
      recordSuccess(catalog);
      return { catalog, hubUrl: ctx.hubUrl, degraded: false, notEnrolled: false, stale: false };
    } catch (err) {
      // 失败回落已知快照（不写退避/degraded——语义契约见接口 docstring）；
      // 真闸门在下载链：目录能回落说明 hub 曾可达，回落快照的 downloadUrl
      // 仍指向该 hub，hub 真不可达时下载会如实失败。
      logger.warn('hub catalog fresh 拉取失败，安装链回落已知快照', {
        error: err instanceof Error ? err.message : String(err),
      });
      const known = cache?.catalog ?? lastGoodCatalog ?? EMPTY_CATALOG;
      // stale=true：本次装的是回落快照而非 hub 最新目录——安装链据此拒绝
      // 「已是最新」的假结论与「已下架」的假归因（M2.4 T1）。
      return { catalog: known, hubUrl: ctx.hubUrl, degraded, notEnrolled: false, stale: true };
    }
  }

  return {
    load,
    loadFresh,
    isDegraded: () => degraded,
    resetForTest: () => {
      cache = null;
      failureBackoffUntil = 0;
      lastGoodCatalog = null;
      inflightRefresh = null;
      degraded = false;
    },
    rewindCacheForTest: (ms) => {
      if (cache) cache.expiresAt -= ms;
    },
    rewindFailureBackoffForTest: (ms) => {
      failureBackoffUntil -= ms;
    },
  };
}

/** 生产单例（HubManager 配置 + keychain 凭证） */
const defaultSource = createHubCatalogSource(() => contextResolver());

/** hub 目录当前是否降级——resource:getCatalogStatus 聚合消费 */
export function isHubCatalogDegraded(): boolean {
  return defaultSource.isDegraded();
}

/**
 * hub 是否未接入（配置缺失）——resource:getCatalogStatus 同步读取面（M2.5 终审
 * FIX-1）。事实源与 load() 的 notEnrolled 判定同源：hubGetStatus().configured。
 * 同步判定（hubGetStatus 读 HubManager 内存配置），不新增 RPC、不依赖目录是否
 * 已拉取——冷启动首帧即可如实回答，renderer 播种门控据此拒绝建基线。
 */
export function isHubNotEnrolled(): boolean {
  return !hubGetStatus().configured;
}

/** hub 原始元数据（含 versions 数组——T9 仅透传，版本比较语义留 T10/T14） */
export async function listHubResourceMetas(type?: HubMarketplaceType): Promise<HubResourceMeta[]> {
  const { catalog } = await defaultSource.load();
  return catalog.items.filter((m) => isMarketplaceType(m.type) && (!type || m.type === type));
}

/** hub 目录项 → MarketplaceItem（installPackage 原样消费——spec §6.2） */
export async function listHubMarketplaceItems(type?: ResourceType): Promise<MarketplaceItem[]> {
  const { catalog, hubUrl } = await defaultSource.load();
  if (!hubUrl) return [];
  return catalog.items
    .filter((m) => isMarketplaceType(m.type) && (!type || m.type === type))
    .map((m) => toMarketplaceItem(m, hubUrl));
}

/**
 * hub 目录项按 type + slug 精确查（安装分支消费）。
 * 载入走 loadFresh（M2.3 T2，D3-1/O1-1）：安装/更新链强制拉最新目录——
 * hub v0.1.5 起 latest = versions 全集 semver max（乱序发布不回退），meta.version
 * 即应装版本；TTL/退避/lastGood 的陈旧快照只服务浏览链（load），不进版本取值链。
 *
 * M2.4 T1：交回 item + 本次载入是否回落（stale）+ 接入态（enrolled）——
 * 安装链按「enrolled → stale → item」判定，回落快照不得冒充 hub 最新目录。
 * hubUrl 为 null（未接入）时 item=null。
 */
export async function findHubMarketplaceItem(
  type: ResourceType,
  slug: string,
): Promise<{ item: MarketplaceItem | null; stale: boolean; enrolled: boolean }> {
  const { catalog, hubUrl, stale, notEnrolled } = await defaultSource.loadFresh();
  const enrolled = !notEnrolled;
  if (!hubUrl) return { item: null, stale, enrolled };
  const meta = catalog.items.find((m) => m.type === type && m.slug === slug);
  if (!meta || !isMarketplaceType(meta.type)) return { item: null, stale, enrolled };
  return { item: toMarketplaceItem(meta, hubUrl), stale, enrolled };
}

/** MarketplaceItem → HubEntry（registryList 消费面——与 smithery 同构） */
function toHubEntry(item: MarketplaceItem): HubEntry {
  const resource: ResourceItem = fromCatalogItem(item, 'hub');
  return {
    id: resource.id,
    type: item.type,
    name: item.name,
    description: item.description,
    version: item.version,
    tags: item.tags,
    category: item.category,
    item: resource,
  };
}

/** 关键词匹配（name/description/slug/tags——与 marketplace searchItems 同口径） */
function matchesQuery(item: MarketplaceItem, query?: string): boolean {
  const q = query?.trim().toLowerCase();
  if (!q) return true;
  return (
    item.name.toLowerCase().includes(q) ||
    item.description.toLowerCase().includes(q) ||
    item.slug.toLowerCase().includes(q) ||
    item.tags.some((t) => t.toLowerCase().includes(q))
  );
}

/**
 * momo-hub provider（资源库第五源——spec §6.1）。
 * 目录无服务端分页：page 参数忽略、hasMore 恒 false（与 builtin 源同款）。
 */
export function createHubProvider(source: HubCatalogSource): HubProvider {
  return {
    key: 'hub',
    label: 'momo-hub',
    region: 'local',
    types: ['agent', 'mcp', 'skill', 'plugin'],
    async list(type, query, _page): Promise<HubListResult> {
      const { catalog, hubUrl, degraded: deg, notEnrolled } = await source.load();
      if (notEnrolled || !hubUrl) {
        return { entries: [], degraded: false, hasMore: false, notEnrolled: true };
      }
      const items = catalog.items
        .filter((m) => isMarketplaceType(m.type))
        .filter((m) => m.type === type)
        .map((m) => toMarketplaceItem(m, hubUrl))
        .filter((item) => matchesQuery(item, query));
      return {
        entries: items.map(toHubEntry),
        degraded: deg,
        hasMore: false,
        notEnrolled: false,
      };
    },
  };
}

/** 生产 provider（挂 HUB_PROVIDERS 注册表） */
export const hubProvider: HubProvider = createHubProvider(defaultSource);
