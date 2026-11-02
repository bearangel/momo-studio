// electron/src/main/marketplace/client.ts
//
// Marketplace catalog 客户端：fetchCatalog（远程优先、本地回退）+
// searchItems（关键词 + 类型过滤）+ groupByCategory（UI 分组展示）。

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
import {
  isValidSlug,
  isValidVersion,
  isValidSha256Hex,
  type Catalog,
  type MarketplaceItem,
} from './types';

const DEFAULT_CATALOG_URL =
  'https://raw.githubusercontent.com/momo-studio/marketplace/main/resources/marketplace/catalog.json';

/** item.type 合法枚举 */
const ITEM_TYPES = new Set(['agent', 'mcp', 'skill']);

/** verificationStatus 合法枚举 */
const VERIFICATION_STATUSES = new Set(['unverified', 'community', 'verified', 'official']);

/**
 * 校验 catalog 结构（S1 注入防线）：item.type 枚举、slug/version 白名单字符集、
 * downloadUrl 强制 https、checksum 形状。catalog 来自未签名的远程源——任何一项
 * 不合法都视为整个 catalog 被篡改/损坏，调用方回退本地内置 catalog。
 */
export function validateCatalog(raw: unknown): Catalog {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('catalog 结构非法：顶层不是对象');
  }
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.version !== 'string' ||
    typeof candidate.updatedAt !== 'string' ||
    !Array.isArray(candidate.items)
  ) {
    throw new Error('catalog 结构非法：version / updatedAt / items 缺失或类型不符');
  }

  candidate.items.forEach((rawItem, index) => {
    if (typeof rawItem !== 'object' || rawItem === null) {
      throw new Error(`catalog.items[${index}] 不是对象`);
    }
    const item = rawItem as Record<string, unknown>;
    const label = typeof item.slug === 'string' ? item.slug : `items[${index}]`;

    if (typeof item.id !== 'string' || typeof item.name !== 'string' ||
        typeof item.author !== 'string' || typeof item.description !== 'string' ||
        typeof item.readme !== 'string' || typeof item.category !== 'string' ||
        typeof item.iconEmoji !== 'string') {
      throw new Error(`catalog 项 ${label} 的基础字符串字段缺失或类型不符`);
    }
    if (typeof item.type !== 'string' || !ITEM_TYPES.has(item.type)) {
      throw new Error(`catalog 项 ${label} 的 type 非法: ${String(item.type)}`);
    }
    if (typeof item.slug !== 'string' || !isValidSlug(item.slug)) {
      throw new Error(`catalog 项 ${label} 的 slug 含非法字符`);
    }
    if (typeof item.version !== 'string' || !isValidVersion(item.version)) {
      throw new Error(`catalog 项 ${label} 的 version 含非法字符`);
    }
    if (
      typeof item.verificationStatus !== 'string' ||
      !VERIFICATION_STATUSES.has(item.verificationStatus)
    ) {
      throw new Error(`catalog 项 ${label} 的 verificationStatus 非法`);
    }
    if (!Array.isArray(item.tags) || item.tags.some((t) => typeof t !== 'string')) {
      throw new Error(`catalog 项 ${label} 的 tags 不是字符串数组`);
    }
    if (
      typeof item.downloadUrl !== 'string' ||
      (item.downloadUrl !== '' && !item.downloadUrl.startsWith('https://'))
    ) {
      throw new Error(`catalog 项 ${label} 的 downloadUrl 必须为空串或 https 地址`);
    }
    if (
      typeof item.checksum !== 'string' ||
      (item.checksum !== '' && !isValidSha256Hex(item.checksum))
    ) {
      throw new Error(`catalog 项 ${label} 的 checksum 必须为空串或 sha256 hex`);
    }
    if (typeof item.sizeBytes !== 'number' || typeof item.installCount !== 'number') {
      throw new Error(`catalog 项 ${label} 的 sizeBytes / installCount 不是数字`);
    }
  });

  return candidate as unknown as Catalog;
}

/** 解析本地 catalog 路径（打包后从 resources 目录加载，dev 从源码目录加载） */
function resolveLocalCatalogPath(): string {
  // 打包模式：process.resourcesPath 指向 app/Contents/Resources/ (macOS) 或 resources/ (Linux/Win)
  if (process.resourcesPath && !process.defaultApp) {
    return path.join(process.resourcesPath, 'marketplace', 'catalog.json');
  }
  // Dev 模式：从编译后的 dist 向上找源码目录
  return path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'marketplace', 'catalog.json');
}

/** catalog 进程内 TTL 缓存时长（I6）：成功结果缓存 5 分钟 */
export const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 失败退避首档窗口时长：窗口内直接本地回退、零网络重试。
 * 兼容导出（既有消费方/测试引用）；指数序列见 CATALOG_FAILURE_BACKOFF_STEPS_MS。
 */
export const CATALOG_FAILURE_BACKOFF_MS = 60 * 1000;

/**
 * 失败退避指数序列（M2.2 P2-9）：连续失败第 1 / 2 / 3+ 次分别退避
 * 60s → 5min → 30min（封顶），成功即清零。取代固定 60s 窗口——远程 catalog
 * 持久 404 / 网络长期不可达时不再每分钟刷一次失败日志与重试请求。
 */
export const CATALOG_FAILURE_BACKOFF_STEPS_MS: readonly number[] = [
  CATALOG_FAILURE_BACKOFF_MS, // 第 1 次失败：60s
  5 * 60 * 1000, // 第 2 次：5min
  30 * 60 * 1000, // 第 3 次起：30min 封顶
];

/**
 * catalog 进程内缓存（I6）：URL → { expiresAt, catalog }，仅缓存远程成功结果。
 * 失败退避负缓存（2026-09-22 方案 A）：URL → 失败退避截止时刻。离线环境下成功
 * 缓存从未建立，若失败不记忆，resource.list（面板切换 / MentionInput 挂载等高频
 * 路径）每次都同步重试远程、吃满网络超时才回退本地。窗口内二次调用零网络请求；
 * 窗口过期后重试远程，网络恢复即可拿到新目录（最长延迟一个退避窗口）。
 *
 * SWR 已知结果（2026-10-08）：远程 URL 长期 404 / 网络慢（实测 TLS 握手 + 往返
 * 0.8~1.8s）时成功缓存从未建立，「窗口过期即同步重试远程」会让资源库 agent/
 * mcp/skill 切页每 60s 吃到一次完整网络往返。现改为：有已知结果（远程成功或本地
 * 回退，lastGoodCatalog）时立即返回旧值，网络重试转后台单飞（inflightRefresh），
 * 后台成功即建立 TTL 缓存 / 失败即续退避。仅进程内首次调用（无任何已知结果）
 * 保留阻塞式远程优先语义。
 */
const catalogCache = new Map<string, { expiresAt: number; catalog: Catalog }>();
const catalogFailureBackoff = new Map<string, number>();
/** URL → 连续失败次数（指数退避步进计数；成功清零） */
const catalogFailureStreak = new Map<string, number>();
const lastGoodCatalog = new Map<string, Catalog>();
const inflightRefresh = new Map<string, Promise<void>>();
/**
 * D9（走查 2026-10-12）：远程目录降级态（URL → 正在用本地回退）。
 * true = 远程获取失败过且尚未恢复（退避中 / lastGood 为本地副本）；
 * 远程成功即翻 false。resource:getCatalogStatus 透传给 renderer，
 * 资源库显示「网络目录暂时不可达」提示条。
 */
const catalogDegraded = new Map<string, boolean>();

/** 按连续失败次数取退避窗口（越界取末档——30min 封顶语义） */
function failureBackoffDelayMs(consecutiveFailures: number): number {
  const idx = Math.min(consecutiveFailures, CATALOG_FAILURE_BACKOFF_STEPS_MS.length - 1);
  return CATALOG_FAILURE_BACKOFF_STEPS_MS[idx] ?? CATALOG_FAILURE_BACKOFF_MS;
}

/**
 * D13：退避抖动因子（0~0.2 随机）——可测试注入钉确定性（档位序列锁需要零抖动）。
 */
let backoffJitter = (): number => Math.random() * 0.2;
/** @internal 仅供测试注入确定性抖动因子 */
export function __setBackoffJitterForTest(fn: () => number): void {
  backoffJitter = fn;
}

/**
 * 记一次失败：连续失败计数 +1 并推进指数退避窗口（60s → 5min → 30min 封顶）。
 * 成功路径在 fetchRemoteCatalog 内清零（清窗口 + 清计数）。
 */
function recordCatalogFailure(url: string): void {
  const streak = catalogFailureStreak.get(url) ?? 0;
  catalogFailureStreak.set(url, streak + 1);
  // D13（验收报告）：+≤20% jitter——多实例/多表面同刻失败时错峰重试
  catalogFailureBackoff.set(url, Date.now() + failureBackoffDelayMs(streak) * (1 + backoffJitter()));
  catalogDegraded.set(url, true);
  // 日志收敛：每 streak 只打一次（旧实现退避窗口内每次调用都打 info——多表面
  // 叠加成 18s 级重复噪音）
  logger.warn('远程 catalog 失败进入退避', { url, streak, backoffMs: failureBackoffDelayMs(streak) });
}

/**
 * 获取 catalog：优先远程（结构校验失败视为被篡改），失败回退本地内置；
 * 远程成功结果按 URL 缓存 CATALOG_CACHE_TTL_MS（I6），失败进指数退避
 * 负缓存（P2-9）；已有已知结果时旧值直返 + 后台单飞刷新（SWR，切页路径零网络阻塞）
 */
export async function fetchCatalog(catalogUrl?: string): Promise<Catalog> {
  const url = catalogUrl ?? DEFAULT_CATALOG_URL;

  const hit = catalogCache.get(url);
  if (hit && hit.expiresAt > Date.now()) return hit.catalog;

  // 退避窗口内零网络——现读本地（readFileSync 毫秒级，保持本地面新鲜）。
  // D13：窗口内静默——退避已由 recordCatalogFailure 按 streak 打点，此处不再逐调用重复
  if ((catalogFailureBackoff.get(url) ?? 0) > Date.now()) {
    catalogDegraded.set(url, true);
    return readLocalCatalog(url);
  }

  // 进程内首次（无任何已知结果）：维持远程优先——唯一允许阻塞调用方的路径
  const known = hit?.catalog ?? lastGoodCatalog.get(url);
  if (!known) {
    try {
      return await fetchRemoteCatalog(url);
    } catch (err) {
      logger.warn('远程 catalog 获取或校验失败，使用本地', { error: (err as Error).message });
      recordCatalogFailure(url);
      return readLocalCatalog(url);
    }
  }

  // 已有已知结果（过期成功缓存或本地回退）：立即返回旧值，后台单飞刷新——
  // 切页路径不阻塞，网络恢复后下一次调用即可拿到新目录
  void refreshInBackground(url);
  return known;
}

/** 拉远程 catalog（3s 超时）：非 2xx / 校验失败一律 throw 由调用方处置 */
async function fetchRemoteCatalog(url: string): Promise<Catalog> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`远程 catalog 响应非 2xx：${response.status}`);
  const raw = (await response.json()) as unknown;
  // 结构校验失败视为被篡改 → throw → 调用方回退本地
  const catalog = validateCatalog(raw);
  catalogCache.set(url, { expiresAt: Date.now() + CATALOG_CACHE_TTL_MS, catalog });
  lastGoodCatalog.set(url, catalog);
  // 成功清零：退避窗口与连续失败计数一并清（P2-9——下次失败从 60s 首档重新起步）
  catalogFailureBackoff.delete(url);
  catalogFailureStreak.delete(url);
  catalogDegraded.set(url, false);
  logger.info('Marketplace catalog 已加载（远程）', { items: catalog.items.length });
  return catalog;
}

/** 读本地内置 catalog（纯读：校验后直返，不触碰缓存态——镜像 catalog 自愈等
 *  需要确定性本地清单的消费方用这个；不合法直接抛错） */
export function readBundledCatalog(): Catalog {
  return validateCatalog(
    JSON.parse(fs.readFileSync(resolveLocalCatalogPath(), 'utf-8')) as unknown,
  );
}

/** 读本地内置 catalog（过校验纵深防御；不合法直接抛错）并记为已知结果 */
function readLocalCatalog(url: string): Catalog {
  const local = readBundledCatalog();
  lastGoodCatalog.set(url, local);
  logger.info('Marketplace catalog 已加载（本地）', { items: local.items.length });
  return local;
}

/** 后台刷新（单飞）：成功建立 TTL 缓存 + 清退避；失败按指数序列续退避。错误吞掉只记日志 */
function refreshInBackground(url: string): void {
  if (inflightRefresh.has(url)) return;
  const task = (async () => {
    try {
      await fetchRemoteCatalog(url);
    } catch (err) {
      recordCatalogFailure(url);
      logger.warn('后台刷新远程 catalog 失败，续退避窗口', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inflightRefresh.delete(url);
    }
  })();
  inflightRefresh.set(url, task);
}

/** D9：远程目录当前是否降级（本地回退在役）——resource:getCatalogStatus 消费 */
export function isCatalogDegraded(catalogUrl?: string): boolean {
  return catalogDegraded.get(catalogUrl ?? DEFAULT_CATALOG_URL) === true;
}

/** 测试用：清空 catalog 缓存（隔离用例间缓存副作用） */
export function __resetCatalogCacheForTest(): void {
  catalogCache.clear();
  catalogFailureBackoff.clear();
  catalogFailureStreak.clear();
  lastGoodCatalog.clear();
  inflightRefresh.clear();
  catalogDegraded.clear();
}

/** 测试用：读当前失败退避窗口剩余毫秒（0 = 无退避；指数序列断言用） */
export function __getFailureBackoffRemainingForTest(catalogUrl?: string): number {
  const until = catalogFailureBackoff.get(catalogUrl ?? DEFAULT_CATALOG_URL) ?? 0;
  return Math.max(0, until - Date.now());
}

/** 测试用：把缓存条目的过期时刻整体前移 ms（模拟 TTL 过期，不伪造系统时钟） */
export function __rewindCatalogCacheForTest(ms: number): void {
  for (const entry of catalogCache.values()) entry.expiresAt -= ms;
}

/** 测试用：把失败退避截止时刻整体前移 ms（模拟退避窗口流逝，不伪造系统时钟） */
export function __rewindFailureBackoffForTest(ms: number): void {
  for (const [url, until] of catalogFailureBackoff) catalogFailureBackoff.set(url, until - ms);
}

/** 搜索 catalog：关键词匹配 name/description/slug/tags，可选按类型过滤 */
export function searchItems(catalog: Catalog, query: string, type?: string): MarketplaceItem[] {
  const q = query.toLowerCase().trim();
  return catalog.items.filter((item) => {
    if (type && item.type !== type) return false;
    if (!q) return true;
    return (
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.slug.toLowerCase().includes(q) ||
      item.tags.some((t) => t.toLowerCase().includes(q))
    );
  });
}

/** 按 category 分组（UI 分类展示用） */
export function groupByCategory(items: MarketplaceItem[]): Map<string, MarketplaceItem[]> {
  const groups = new Map<string, MarketplaceItem[]>();
  for (const item of items) {
    const list = groups.get(item.category) ?? [];
    list.push(item);
    groups.set(item.category, list);
  }
  return groups;
}
