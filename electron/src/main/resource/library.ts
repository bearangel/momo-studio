// electron/src/main/resource/library.ts
//
// listResources：统一三源（builtin/custom/marketplace）资源列表的主入口。
// 内部一次 fetchCatalog（远程优先 + 本地回退），按 downloadUrl 分流到 builtin/marketplace，
// 再合并 custom。fetchCatalog 失败时只丢 builtin+marketplace，custom 仍正常返回。
//
// filter 支持按 type/source 过滤。filter.source 指定时短路不必要源（避免 fetchCatalog）。

import { fetchCatalog } from '../marketplace/client';
import { listBuiltinResources } from './builtin';
import { listMarketplaceResources } from './marketplace';
import { listCustomResources } from './custom';
import { parseResourceId, type ResourceFilter, type ResourceItem } from './types';
import { logger } from '../logger';

export async function listResources(filter?: ResourceFilter): Promise<ResourceItem[]> {
  const needCatalog = !filter?.source || filter.source === 'builtin' || filter.source === 'marketplace';
  const needCustom = !filter?.source || filter.source === 'custom';

  // 并行：catalog（如需要）+ custom
  const tasks: Promise<unknown>[] = [];

  let builtinItems: ResourceItem[] = [];
  let marketplaceItems: ResourceItem[] = [];

  if (needCatalog) {
    tasks.push(
      fetchCatalog()
        .then((catalog) => {
          builtinItems = listBuiltinResources(catalog);
          marketplaceItems = listMarketplaceResources(catalog);
        })
        .catch((err) => {
          logger.warn('listResources: fetchCatalog 失败，builtin/marketplace 返回空', { error: (err as Error).message });
        }),
    );
  }

  let customItems: ResourceItem[] = [];
  if (needCustom) {
    tasks.push(
      Promise.resolve().then(() => {
        customItems = listCustomResources();
      }),
    );
  }

  await Promise.all(tasks);

  let items = [...builtinItems, ...marketplaceItems, ...customItems];

  // 按 type 过滤
  if (filter?.type) {
    items = items.filter((i) => i.type === filter.type);
  }
  // 按 source 过滤（filter.source 已用于短路，但保险起见再过滤一次）
  if (filter?.source) {
    items = items.filter((i) => i.source === filter.source);
  }

  return items;
}

export async function resolveResourceById(id: string): Promise<ResourceItem | null> {
  const parsed = parseResourceId(id);
  if (!parsed) return null;
  const items = await listResources({ type: parsed.type, source: parsed.source });
  return items.find((i) => i.id === id) ?? null;
}
