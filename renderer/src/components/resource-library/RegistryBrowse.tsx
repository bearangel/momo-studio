// renderer/src/components/resource-library/RegistryBrowse.tsx
// 网络获取模式（spec §4.4）：provider 选择 + 经 IPC 取数（P2 双轨 hub，Task 6）
// + 前端搜索/分类 chips + 行列表。行的已安装态从 resource store 实时派生
// （安装成功刷新 store 即翻转，非挂载时快照）；点行在右栏挂载 ResourceDetail。
// 置灰语义（Task 4 审查裁定）：option disabled 由该源最新已知 degraded 驱动——
// 未探测取 registryProviders 的 meta.degraded 初值；registryList 结果双向更新
// （恢复即解灰，不因短暂 degraded 永久禁用）。结果态的 degraded 且空条目
// → 不可达空态文案 + 重试按钮（attempt 递增重挂 effect）。
import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ResourceType, RegistryProviderMeta } from '../../ipc/types';
import { ipc } from '../../ipc/client';
import { EmptyState } from '../ui/EmptyState';
import { Input } from '../ui/Input';
import { ResourceRow } from './ResourceRow';
import { ResourceDetail } from './ResourceDetail';
import { useResourceStore } from '../../stores/resource.store';
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
  const providerKey = useResourceStore((s) => s.registryProviderKey);
  const setRegistryProvider = useResourceStore((s) => s.setRegistryProvider);

  // null = provider 元信息未就位（数据 effect 据此等待，防记忆源先发错配请求）
  const [providers, setProviders] = useState<RegistryProviderMeta[] | null>(null);
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 最近一次 registryList 的 degraded（结果态——驱动不可达空态）
  const [degraded, setDegraded] = useState(false);
  // 各源最新已知 degraded（option 置灰信号；未探测的源取 meta.degraded 初值）
  const [optionDegraded, setOptionDegraded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // 递增触发重试（重试按钮 = attempt 变化重挂 effect）
  const [attempt, setAttempt] = useState(0);
  // 点选行 id（spec §4.4：右栏挂载 ResourceDetail；条目从 visible 消失时自动收起）
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // provider 元信息：挂载/切类型拉一次，按当前 type 过滤（hub 仅支持 mcp）
  useEffect(() => {
    let cancelled = false;
    ipc.resource
      .registryProviders()
      .then((metas) => {
        if (!cancelled) setProviders(metas.filter((p) => p.types.includes(type)));
      })
      .catch(() => {
        // 元信息失败 → 仅剩 builtin 兜底（本地 IPC 处理器，实际不可达路径）
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [type]);

  // 记忆源不支持当前 type（如 smithery 仅 mcp）→ 回退 builtin（防错配 IPC 抛错）
  const effectiveKey: RegistryProviderMeta['key'] =
    providers !== null && !providers.some((p) => p.key === providerKey)
      ? 'builtin'
      : providerKey;

  useEffect(() => {
    if (providers === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDegraded(false);
    ipc.resource
      .registryList(effectiveKey, type)
      .then((result) => {
        if (cancelled) return;
        setEntries(result.entries);
        setDegraded(result.degraded);
        // 结果双向更新该源置灰信号（恢复即解灰——Task 4 审查裁定）
        setOptionDegraded((prev) => ({ ...prev, [effectiveKey]: result.degraded }));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [providers, effectiveKey, type, attempt]);

  // 已安装态实时派生：安装成功 → store.load() 刷新 items → 行即刻翻转「已安装」
  const installedItems = useResourceStore((s) => s.items);
  const installedIds = useMemo(() => new Set(installedItems.map((i) => i.id)), [installedItems]);

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

  const selectedEntry = selectedId ? (visible.find((e) => e.id === selectedId) ?? null) : null;

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
    <div className="flex-1 flex overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 工具栏：搜索 + 分类 chips + provider 选择器 */}
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
          {/* provider 选择器（spec §4.4 预留位兑现）：手动选择 + 不可达置灰 + 记忆 */}
          <select
            aria-label="registry provider"
            className="ml-auto text-xs px-2 py-1 rounded-md bg-surface-3 text-secondary border border-subtle"
            value={effectiveKey}
            onChange={(e) => {
              // 切源即换目录——分类 chip 是旧目录的 tag，留着会误过滤新目录
              setTagFilter(null);
              void setRegistryProvider(e.target.value as RegistryProviderMeta['key']);
            }}
          >
            {(providers ?? []).map((p) => {
              const isDegraded = optionDegraded[p.key] ?? p.degraded;
              return (
                <option key={p.key} value={p.key} disabled={isDegraded}>
                  {p.label}
                  {isDegraded ? '（当前网络不可达）' : ''}
                </option>
              );
            })}
          </select>
        </div>

        <div className="flex-1 overflow-auto p-4 flex flex-col gap-1.5">
          {loading ? (
            <div className="text-center text-tertiary text-sm py-8">加载中…</div>
          ) : degraded && entries.length === 0 ? (
            // 结果态降级（Task 4 审查裁定措辞）：工具栏保留——可切其它来源
            <div className="flex-1 flex flex-col items-center justify-center gap-2">
              <p className="text-sm text-status-error">该来源当前网络不可达，可稍后重试或切换来源</p>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-surface-active text-accent-600 dark:text-accent-300"
                onClick={() => setAttempt((n) => n + 1)}
              >
                <RefreshCw size={12} strokeWidth={1.75} aria-hidden />
                重试
              </button>
            </div>
          ) : visible.length === 0 ? (
            <EmptyState icon={RefreshCw} title="目录中没有匹配项" description="试试清除搜索或切换分类" />
          ) : (
            visible.map((e) => (
              <ResourceRow
                key={e.id}
                item={{ ...e.item, installed: installedIds.has(e.id) }}
                selected={selectedId === e.id}
                onSelect={setSelectedId}
                onInstall={onInstall}
              />
            ))
          )}
        </div>
      </div>

      {selectedEntry && (
        <ResourceDetail
          item={{ ...selectedEntry.item, installed: installedIds.has(selectedEntry.id) }}
          onClose={() => setSelectedId(null)}
          onInstall={onInstall}
        />
      )}
    </div>
  );
}
