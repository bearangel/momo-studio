// renderer/src/components/resource-library/RegistryBrowse.tsx
// 网络获取模式（spec §4.4）：RegistryProvider 拉取 + 前端搜索/分类 chips + 行列表。
// v1 Provider = 内置市场；未来多 Provider 时顶部说明位变选择器。
import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ResourceType } from '../../ipc/types';
import { EmptyState } from '../ui/EmptyState';
import { Input } from '../ui/Input';
import { ResourceRow } from './ResourceRow';
import { marketplaceCatalogProvider } from '../../services/registry/marketplace-catalog-provider';
import type { RegistryEntry } from '../../services/registry/types';

interface RegistryBrowseProps {
  type: ResourceType;
  /** 安装回调（透传 resource.id——禁止重新生成，momo-boundary-rules） */
  onInstall: (id: string) => void;
}

/** 分类 chips：条目 tags 去重取 Top 8 */
function topTags(entries: RegistryEntry[]): string[] {
  const count = new Map<string, number>();
  for (const e of entries) for (const t of e.tags) count.set(t, (count.get(t) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
}

export function RegistryBrowse({ type, onInstall }: RegistryBrowseProps) {
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // 递增触发重试（重试按钮 = attempt 变化重挂 effect）
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    marketplaceCatalogProvider
      .list(type)
      .then((list) => { if (!cancelled) setEntries(list); })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [type, attempt]);

  const tags = useMemo(() => topTags(entries), [entries]);
  const q = query.trim().toLowerCase();
  const visible = entries.filter((e) => {
    if (tagFilter && !e.tags.includes(tagFilter)) return false;
    if (!q) return true;
    return (
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.item.slug.toLowerCase().includes(q)
    );
  });

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 p-8">
        <p className="text-sm text-status-error">加载失败：{error}</p>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-surface-active text-accent-600 dark:text-accent-300"
          onClick={() => setAttempt((n) => n + 1)}
        >
          <RefreshCw size={12} strokeWidth={1.75} aria-hidden />
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 工具栏：搜索 + 分类 chips + 来源标注 */}
      <div className="px-4 py-2.5 border-b border-subtle flex items-center gap-2 flex-wrap">
        <div className="w-56">
          <Input placeholder="搜索名称 / 描述 / slug…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {tags.map((t) => (
          <button
            key={t}
            type="button"
            className={tagFilter === t
              ? 'text-xs px-2 py-0.5 rounded-full bg-surface-active text-accent-600 dark:text-accent-300'
              : 'text-xs px-2 py-0.5 rounded-full bg-surface-3 text-secondary hover:bg-surface-active'}
            onClick={() => setTagFilter(tagFilter === t ? null : t)}
          >
            {t}
          </button>
        ))}
        <span className="ml-auto text-xs text-tertiary">来源：{marketplaceCatalogProvider.label}</span>
      </div>

      <div className="flex-1 overflow-auto p-4 flex flex-col gap-1.5">
        {loading ? (
          <div className="text-center text-tertiary text-sm py-8">加载中…</div>
        ) : visible.length === 0 ? (
          <EmptyState icon={RefreshCw} title="目录中没有匹配项" description="试试清除搜索或切换分类" />
        ) : (
          visible.map((e) => (
            <ResourceRow key={e.id} item={e.item} selected={false} onSelect={() => undefined} onInstall={onInstall} />
          ))
        )}
      </div>
    </div>
  );
}
