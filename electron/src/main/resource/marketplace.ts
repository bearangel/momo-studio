// electron/src/main/resource/marketplace.ts
//
// listMarketplaceResources：从已 fetch 的 catalog 中过滤出 downloadUrl 非空的真远程包。
// 当前 catalog.json 全是 downloadUrl="" 内联项 → 实际返回空数组；
// 未来真接 marketplace 后，远程包在这里出现。
//
// 与 listBuiltinResources 一样是纯函数，catalog 由 library.ts（Task 4）共享传入。

import type { Catalog } from '../marketplace/types';
import type { ResourceItem } from './types';
import { fromCatalogItem } from './catalog-adapter';

/**
 * 从 catalog 中过滤出 marketplace 资源（downloadUrl 非空的远程项）。
 *
 * @param catalog 已 fetch 的 Catalog 对象（由调用方共享传入）
 * @returns ResourceItem[]，每项 source='marketplace'，installed 由 listInstalled() 判断
 */
export function listMarketplaceResources(catalog: Catalog): ResourceItem[] {
  return catalog.items
    .filter((item) => item.downloadUrl)
    .map((item) => fromCatalogItem(item, 'marketplace'));
}
