// renderer/src/services/registry/marketplace-catalog-provider.ts
//
// v1 唯一 Provider：本地打包的 marketplace catalog（经现有 resource:list 通道）。
// 排序：未安装在前（浏览目标优先），已安装垫底（供确认「已装过」）。
import { ipc } from '../../ipc/client';
import type { ResourceItem, ResourceType } from '../../ipc/types';
import type { RegistryEntry, RegistryProvider } from './types';

function toEntry(item: ResourceItem): RegistryEntry {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    description: item.description,
    version: item.version,
    tags: item.marketplace?.tags ?? [],
    category: item.marketplace?.category,
    item,
  };
}

/** 前端模糊匹配（name/description/slug，case-insensitive——与已安装列表搜索同语义） */
function matches(entry: RegistryEntry, q: string): boolean {
  const lower = q.toLowerCase();
  return (
    entry.name.toLowerCase().includes(lower) ||
    entry.description.toLowerCase().includes(lower) ||
    entry.item.slug.toLowerCase().includes(lower)
  );
}

export const marketplaceCatalogProvider: RegistryProvider = {
  key: 'marketplace',
  label: '内置市场',
  async list(type: ResourceType, query?: string): Promise<RegistryEntry[]> {
    const items = await ipc.resource.list({ type, source: 'marketplace' });
    const entries = items.map(toEntry);
    const filtered = query?.trim() ? entries.filter((e) => matches(e, query.trim())) : entries;
    return filtered.sort((a, b) => Number(a.item.installed) - Number(b.item.installed));
  },
};