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

/** 获取 catalog：优先远程（结构校验失败视为被篡改），失败回退本地内置 */
export async function fetchCatalog(catalogUrl?: string): Promise<Catalog> {
  const url = catalogUrl ?? DEFAULT_CATALOG_URL;

  // 尝试远程（10s 超时，避免 UI 长时间卡住）
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const raw = (await response.json()) as unknown;
      // 结构校验失败会 throw → 被 catch 捕获 → 回退本地
      const catalog = validateCatalog(raw);
      logger.info('Marketplace catalog 已加载（远程）', { items: catalog.items.length });
      return catalog;
    }
    logger.warn('远程 catalog 响应非 2xx，使用本地', { status: response.status });
  } catch (err) {
    logger.warn('远程 catalog 获取或校验失败，使用本地', { error: (err as Error).message });
  }

  // 回退到本地（应用内置文件，同样过一遍校验作为纵深防御；不合法直接抛错）
  const local = validateCatalog(
    JSON.parse(fs.readFileSync(resolveLocalCatalogPath(), 'utf-8')) as unknown,
  );
  logger.info('Marketplace catalog 已加载（本地）', { items: local.items.length });
  return local;
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
