// electron/src/main/resource/library.ts
//
// listResources：统一四源（builtin/custom/marketplace/p2p）资源列表的主入口。
// 内部一次 fetchCatalog（远程优先 + 本地回退），按 downloadUrl 分流到 builtin/marketplace，
// 再合并 custom（DB/fs 同步读）与 p2p（远端共享目录内存缓存，P4 Task 4）。
// fetchCatalog 失败时只丢 builtin+marketplace，custom/p2p 仍正常返回。
//
// filter 支持按 type/source 过滤。filter.source 指定时短路不必要源（避免 fetchCatalog）。

import { fetchCatalog } from '../marketplace/client';
import { getSharedResources } from '../p2p/resource-share';
import { listBuiltinResources } from './builtin';
import { listMarketplaceResources } from './marketplace';
import { listCustomResources } from './custom';
import {
  buildResourceId,
  parseResourceId,
  type ResourceFilter,
  type ResourceItem,
} from './types';
import { logger } from '../logger';

export async function listResources(filter?: ResourceFilter): Promise<ResourceItem[]> {
  const needCatalog = !filter?.source || filter.source === 'builtin' || filter.source === 'marketplace';
  const needCustom = !filter?.source || filter.source === 'custom';
  const needP2p = !filter?.source || filter.source === 'p2p';

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

  // p2p：远端共享目录（内存缓存同步读，无 IO——不参与上面的并行任务）。
  // id 拼 nodeId 前 8 字符前缀：多节点同名 slug 不碰撞；远端项统一
  // installed=false / installable=true / removable=false（导入落地是 T5 职责）
  let p2pItems: ResourceItem[] = [];
  if (needP2p) {
    p2pItems = getSharedResources().flatMap((node) =>
      node.items.map((entry) => ({
        id: buildResourceId('p2p', entry.type, `${node.nodeId.slice(0, 8)}-${entry.slug}`),
        type: entry.type,
        source: 'p2p' as const,
        slug: entry.slug,
        name: entry.name,
        description: entry.description,
        version: entry.version,
        installed: false,
        installable: true,
        removable: false,
        p2p: { peerId: node.nodeId, peerName: node.nodeName },
      })),
    );
  }

  let items = [...builtinItems, ...marketplaceItems, ...customItems, ...p2pItems];

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
