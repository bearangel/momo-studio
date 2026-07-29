// electron/src/main/marketplace/client.ts
//
// Marketplace catalog 客户端：fetchCatalog（远程优先、本地回退）+
// searchItems（关键词 + 类型过滤）+ groupByCategory（UI 分组展示）。

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
import type { Catalog, MarketplaceItem } from './types';

const DEFAULT_CATALOG_URL =
  'https://raw.githubusercontent.com/momo-studio/marketplace/main/resources/marketplace/catalog.json';

/** 解析本地 catalog 路径（打包后从 resources 目录加载，dev 从源码目录加载） */
function resolveLocalCatalogPath(): string {
  // 打包模式：process.resourcesPath 指向 app/Contents/Resources/ (macOS) 或 resources/ (Linux/Win)
  if (process.resourcesPath && !process.defaultApp) {
    return path.join(process.resourcesPath, 'marketplace', 'catalog.json');
  }
  // Dev 模式：从编译后的 dist 向上找源码目录
  return path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'marketplace', 'catalog.json');
}

/** 获取 catalog：优先远程，失败回退本地内置 */
export async function fetchCatalog(catalogUrl?: string): Promise<Catalog> {
  const url = catalogUrl ?? DEFAULT_CATALOG_URL;

  // 尝试远程（10s 超时，避免 UI 长时间卡住）
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const catalog = (await response.json()) as Catalog;
      logger.info('Marketplace catalog 已加载（远程）', { items: catalog.items.length });
      return catalog;
    }
    logger.warn('远程 catalog 响应非 2xx，使用本地', { status: response.status });
  } catch (err) {
    logger.warn('远程 catalog 获取失败，使用本地', { error: (err as Error).message });
  }

  // 回退到本地
  const local = JSON.parse(fs.readFileSync(resolveLocalCatalogPath(), 'utf-8')) as Catalog;
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
