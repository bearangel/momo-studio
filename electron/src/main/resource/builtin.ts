// electron/src/main/resource/builtin.ts
//
// listBuiltinResources：从已 fetch 的 catalog 中过滤出 downloadUrl="" 的内联项。
// 这些是应用打包自带 + 离线可用的"系统预置"资源（builtin agent / skill / mcp）。
//
// 注意：本函数是纯函数，参数 catalog 由 library.ts（Task 4）一次 fetchCatalog
// 后传入，避免每个 list 函数都触发一次 HTTP 请求——catalog 在调用方共享。

import type { Catalog } from '../marketplace/types';
import type { ResourceItem } from './types';
import { fromCatalogItem } from './catalog-adapter';

/**
 * 从 catalog 中过滤出 builtin 资源（downloadUrl 为空的内联项）。
 *
 * @param catalog 已 fetch 的 Catalog 对象（由调用方共享传入）
 * @returns ResourceItem[]，每项 source='builtin'，installed=true
 */
export function listBuiltinResources(catalog: Catalog): ResourceItem[] {
  return catalog.items
    .filter((item) => !item.downloadUrl)
    .map((item) => fromCatalogItem(item, 'builtin'));
}
