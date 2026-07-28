// Marketplace 主视图：搜索栏 + 类型 tabs（全部/Agent/MCP/Skill）+ 卡片网格 + 右侧详情。
// 进入视图时自动 loadCatalog；搜索/类型切换纯前端过滤（store.setQuery / setTypeFilter）。
// 选中卡片 → 右侧 ItemDetail 展开；再次点击或点关闭收起。
import { useEffect, useState } from 'react';
import { useMarketplaceStore, type TypeFilter } from '../../stores/marketplace.store';
import { Input } from '../ui/Input';
import { cn } from '../../lib/cn';
import { ItemCard } from './ItemCard';
import { ItemDetail } from './ItemDetail';
import type { MarketplaceItem } from '../../ipc/types';

/** 类型 tab 定义 */
const TYPE_TABS: Array<{ key: TypeFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'agent', label: 'Agent' },
  { key: 'mcp', label: 'MCP' },
  { key: 'skill', label: 'Skill' },
];

export function MarketplaceView() {
  const {
    items,
    installed,
    installing,
    typeFilter,
    query,
    loading,
    error,
    loadCatalog,
    setQuery,
    setTypeFilter,
    install,
    uninstall,
  } = useMarketplaceStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 进入视图加载 catalog（store 内部幂等处理已安装列表）
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const selected: MarketplaceItem | undefined = selectedId
    ? items.find((i) => i.id === selectedId) ??
      // 切换类型 tab 后选中项可能不在当前 items 内，从 catalog 兜底查找
      useMarketplaceStore.getState().catalog?.items.find((i) => i.id === selectedId)
    : undefined;

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* 左侧：搜索 + tabs + 网格 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-neutral-200">Marketplace</h2>
            <div className="w-64">
              <Input
                placeholder="搜索 agent / mcp / skill…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-1">
            {TYPE_TABS.map((tab) => (
              <button
                key={tab.key}
                className={cn(
                  'text-xs px-2.5 py-1 rounded-md transition-colors',
                  typeFilter === tab.key
                    ? 'bg-accent-blue text-white'
                    : 'text-neutral-400 hover:bg-bg-tertiary',
                )}
                onClick={() => setTypeFilter(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {error ? (
            <div className="text-center text-status-error text-sm py-8">加载失败：{error}</div>
          ) : loading && items.length === 0 ? (
            <div className="text-center text-neutral-500 text-sm py-8">加载中…</div>
          ) : items.length === 0 ? (
            <div className="text-center text-neutral-500 text-sm py-8">
              <div className="text-3xl mb-2">🛒</div>
              <p>没有匹配的项。试试调整搜索关键词或类型。</p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  installed={installed[item.id]}
                  installing={installing[item.id]}
                  selected={selectedId === item.id}
                  onSelect={() => setSelectedId(selectedId === item.id ? null : item.id)}
                  onInstall={() => void install(item)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 右侧：详情 */}
      {selected && (
        <ItemDetail
          item={selected}
          installed={installed[selected.id]}
          installing={installing[selected.id]}
          onInstall={() => void install(selected)}
          onUninstall={() => void uninstall(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
