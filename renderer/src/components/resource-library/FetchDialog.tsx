// renderer/src/components/resource-library/FetchDialog.tsx
// 获取弹窗（library-store-split spec §2.3，三源同构）：momo-hub / 网络市场 / Smithery。
// 布局与文案为预览合同定值（§C/§D + 定值清单 C1-C19）：
//   - 容器 620px / max-h 560px / 圆角 12px；标题「从 {源名} 获取 · {类型名}」
//   - 搜索（hub/marketplace 目录快照客户端过滤；smithery 服务端分页 + 滚动加载更多）
//   - 行内四态：安装 / 更新（✓已装vN + 描边钮）/ 已装最新（灰显）/ 安装中（脚注进度）
//   - smithery hosted 未部署 → 行内灰显「hosted 未部署 · 不可装」
//   - 特殊态：hub 未接入空态卡（去设置接入）/ 降级 warning 卡（重试）
// 安装链复用 store.installResource（banner + 库页刷新零分叉）；smithery
// needsConfig 两态在弹窗内渲染 schema 表单 → installSmitheryRemote 二段安装。
import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, CloudOff, RotateCw, TriangleAlert, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { compareVersions } from '../../lib/version-compare';
import { useHubStore } from '../../stores/hub.store';
import { useResourceStore } from '../../stores/resource.store';
import { useUiStore } from '../../stores/ui.store';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import type { JsonSchemaLike, RegistryListEntry, ResourceType } from '../../ipc/types';
import {
  FETCH_PROVIDER_KEY,
  FETCH_SOURCE_ICON,
  FETCH_SOURCE_LABEL,
  type FetchSource,
} from './fetch-sources';

/** 类型名（弹窗标题「· {类型名}」段） */
const TYPE_NAME: Record<ResourceType, string> = {
  agent: '智能体',
  mcp: 'MCP',
  skill: '技能',
  plugin: '插件',
};

/** 搜索占位文案（预览 §C/§D 定值） */
const SEARCH_PLACEHOLDER: Record<FetchSource, string> = {
  hub: '搜索名称 / 描述 / slug…',
  marketplace: '搜索…',
  smithery: '搜索服务器…',
};

interface Props {
  source: FetchSource;
  type: ResourceType;
  onClose: () => void;
}

interface RegistryListResult {
  entries: RegistryListEntry[];
  degraded: boolean;
  hasMore: boolean;
  notEnrolled?: boolean;
  nodeName?: string;
  total?: number;
  revision?: number;
}

type RowState = 'install' | 'update' | 'latest' | 'blocked';

/** 本地已装行查找键——按 source:slug 对齐（弹窗行 item.source 即库页已装来源） */
function localKey(entry: RegistryListEntry): string {
  return `${entry.item.source}:${entry.item.slug}`;
}

export function FetchDialog({ source, type, onClose }: Props) {
  const providerKey = FETCH_PROVIDER_KEY[source];
  const SourceIcon = FETCH_SOURCE_ICON[source];
  const items = useResourceStore((s) => s.items);
  // M5.0 本机节点 id（own 行免装判定输入；未接入 null → 无 own 行）
  const selfNodeId = useHubStore((s) => s.status?.nodeId ?? null);

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [entries, setEntries] = useState<RegistryListEntry[]>([]);
  const [meta, setMeta] = useState<{ nodeName?: string; total?: number; revision?: number }>({});
  const [notEnrolled, setNotEnrolled] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [installing, setInstalling] = useState<{
    id: string;
    slug: string;
    name: string;
    percent: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // smithery needsConfig 二段：待配置条目 + schema + 已填值
  const [configTarget, setConfigTarget] = useState<{
    entry: RegistryListEntry;
    schema: JsonSchemaLike;
    values: Record<string, string>;
  } | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const pageRef = useRef(1);

  // smithery 服务端搜索：搜索词防抖 300ms 重查首页（spec §6 首版简单做）
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const loadEntries = useCallback(
    async (opts?: { fresh?: boolean }): Promise<void> => {
      setLoading(true);
      setError(null);
      pageRef.current = 1;
      try {
        const q = source === 'smithery' ? debouncedQuery.trim() || undefined : undefined;
        const r: RegistryListResult = await ipc.resource.registryList(
          providerKey,
          type,
          q,
          1,
          opts?.fresh ? { fresh: true } : undefined,
        );
        setEntries(r.entries);
        setDegraded(r.degraded);
        setNotEnrolled(r.notEnrolled ?? false);
        setHasMore(r.hasMore);
        setMeta({ nodeName: r.nodeName, total: r.total, revision: r.revision });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [providerKey, source, type, debouncedQuery],
  );

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (source !== 'smithery' || !hasMore || loadingMore || loading) return;
    setLoadingMore(true);
    try {
      const r: RegistryListResult = await ipc.resource.registryList(
        providerKey,
        type,
        debouncedQuery.trim() || undefined,
        pageRef.current + 1,
      );
      pageRef.current += 1;
      setEntries((prev) => [...prev, ...r.entries]);
      setHasMore(r.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [providerKey, source, type, debouncedQuery, hasMore, loadingMore, loading]);

  // hub 安装进度事件 → 脚注进度行（字节拍换算百分比；extracting/未知为不定态）
  useEffect(() => {
    const off = ipc.hub.onInstallProgress((e) => {
      if (e.type !== type) return;
      setInstalling((cur) => {
        if (!cur || e.slug !== cur.slug) return cur;
        if (e.stage === 'downloading') {
          const percent =
            typeof e.totalBytes === 'number' && e.totalBytes > 0 && typeof e.receivedBytes === 'number'
              ? Math.min(99, Math.round((e.receivedBytes / e.totalBytes) * 100))
              : null;
          return { ...cur, percent };
        }
        if (e.stage === 'failed') return null;
        return cur;
      });
    });
    return off;
  }, [type]);

  // 本地已装版本表（store.items 已是收窄后的本地实体——直接作已装判定真源）
  const installedVersions = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) {
      if (it.type !== type || !it.installed) continue;
      m.set(`${it.source}:${it.slug}`, it.installedVersion ?? it.version ?? '');
    }
    return m;
  }, [items, type]);

  const rowState = useCallback(
    (entry: RegistryListEntry): RowState => {
      const local = installedVersions.get(localKey(entry));
      if (local === undefined) return entry.item.installable ? 'install' : 'blocked';
      if (entry.version && compareVersions(entry.version, local) > 0) return 'update';
      return 'latest';
    },
    [installedVersions],
  );

  const visibleEntries = useMemo(() => {
    if (source === 'smithery') return entries;
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.item.slug.toLowerCase().includes(q),
    );
  }, [entries, query, source]);

  const handleInstall = useCallback(
    async (entry: RegistryListEntry): Promise<void> => {
      setError(null);
      setConfigError(null);
      setInstalling({ id: entry.item.id, slug: entry.item.slug, name: entry.name, percent: null });
      const result = await useResourceStore.getState().installResource(entry.item.id);
      setInstalling(null);
      // smithery 两态：needsConfig=true 时未安装——弹窗内渲染 schema 表单
      if (result && typeof result === 'object' && 'needsConfig' in result && result.needsConfig) {
        const properties = result.schema?.properties ?? {};
        setConfigTarget({
          entry,
          schema: result.schema ?? {},
          values: Object.fromEntries(Object.keys(properties).map((k) => [k, ''])),
        });
        return;
      }
      if (result === false) {
        setError(useResourceStore.getState().error ?? '安装失败');
        return;
      }
      await loadEntries();
    },
    [loadEntries],
  );

  const submitSmitheryConfig = useCallback(async (): Promise<void> => {
    if (!configTarget) return;
    const required = configTarget.schema.required ?? [];
    const missing = required.filter((k) => configTarget.values[k]?.trim() === '');
    if (missing.length > 0) {
      setConfigError(`请填写必填字段：${missing.join('、')}`);
      return;
    }
    setConfigError(null);
    try {
      await ipc.resource.installSmitheryRemote(
        configTarget.entry.item.id,
        Object.fromEntries(
          Object.entries(configTarget.values).filter(([, v]) => v !== ''),
        ),
      );
      useResourceStore.setState({
        installNotice: `已从 Smithery 安装「${configTarget.entry.name}」`,
      });
      setConfigTarget(null);
      await useResourceStore.getState().load();
      await loadEntries();
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    }
  }, [configTarget, loadEntries]);

  // hub 未接入空态卡「去设置接入」
  const goSettings = useCallback((): void => {
    onClose();
    useUiStore.getState().setActiveView('settings');
  }, [onClose]);

  const footerText = (() => {
    if (source === 'hub') {
      return `已连接 ${meta.nodeName ?? 'momo-hub'} · 目录 ${meta.total ?? entries.length} 项 · 修订 ${meta.revision ?? 0}`;
    }
    if (source === 'marketplace') {
      return `官方内置目录 · ${meta.total ?? entries.length} 项`;
    }
    return 'smithery.ai · 社区目录 · 远程直连注册';
  })();

  // Esc 关闭（capture 阶段，与 ui/Dialog 同语义）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onClose]);

  const onListScroll = (e: UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) void loadMore();
  };

  // 特殊态：hub 未接入（空目录 + notEnrolled）→ 引导卡（预览 §D C18）
  if (notEnrolled) {
    return createPortal(
      <>
        <div className="fixed inset-0 z-50 bg-backdrop" onClick={onClose} aria-hidden />
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`未接入 momo-hub`}
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[420px] rounded-xl border border-subtle bg-canvas shadow-[0_24px_64px_rgba(0,0,0,.28)] px-7 pt-[34px] pb-[30px] text-center"
        >
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-[10px] bg-surface-3 text-tertiary">
            <CloudOff size={22} strokeWidth={1.75} aria-hidden />
          </div>
          <div className="text-[14.5px] font-semibold text-primary">未接入 momo-hub</div>
          <p className="mt-1.5 mb-4 text-[12.5px] text-tertiary">接入后可安装 hub 组内共享资源</p>
          <Button onClick={goSettings}>去设置接入</Button>
        </div>
      </>,
      document.body,
    );
  }

  // 特殊态：降级（hub 目录失败回落 / smithery 网络退避）→ warning 卡 + 重试（预览 §D C19）
  if (degraded) {
    // 标题按预览定值：hub 卡写「hub 暂不可达」（源名短称）；smithery 同构扩展
    const degradedTitle = source === 'hub' ? 'hub 暂不可达' : 'Smithery 暂不可达';
    return createPortal(
      <>
        <div className="fixed inset-0 z-50 bg-backdrop" onClick={onClose} aria-hidden />
        <div
          role="dialog"
          aria-modal="true"
          aria-label={degradedTitle}
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[420px] rounded-xl border border-subtle bg-canvas shadow-[0_24px_64px_rgba(0,0,0,.28)] px-7 pt-[34px] pb-[30px] text-center"
        >
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-[10px] bg-status-warning-tint text-status-warning">
            <TriangleAlert size={22} strokeWidth={1.75} aria-hidden />
          </div>
          <div className="text-[14.5px] font-semibold text-primary">{degradedTitle}</div>
          <p className="mt-1.5 mb-4 text-[12.5px] text-tertiary">
            离线或网络受限{source === 'hub' ? '，展示最近一次目录快照' : '，稍后重试'}
          </p>
          <Button variant="secondary" onClick={() => void loadEntries({ fresh: true })}>
            重试
          </Button>
        </div>
      </>,
      document.body,
    );
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 bg-backdrop" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`从 ${FETCH_SOURCE_LABEL[source]} 获取${TYPE_NAME[type]}`}
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[560px] w-[620px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-subtle bg-canvas shadow-[0_24px_64px_rgba(0,0,0,.28)]"
      >
        {/* 标题行（预览 C2：图标 + 标题 + 「· 类型名」副段 + 关闭钮） */}
        <div className="flex items-center gap-2 px-4 pb-2.5 pt-3.5">
          <SourceIcon size={16} strokeWidth={1.75} aria-hidden className="text-secondary shrink-0" />
          <h2 className="flex items-baseline gap-2 text-[15px] font-semibold text-primary">
            <span>从 {FETCH_SOURCE_LABEL[source]} 获取</span>
            <span className="text-xs font-normal text-tertiary">· {TYPE_NAME[type]}</span>
          </h2>
          <button
            type="button"
            aria-label="关闭"
            className="ml-auto flex text-tertiary hover:text-secondary"
            onClick={onClose}
          >
            <X size={15} strokeWidth={1.75} aria-hidden />
          </button>
        </div>

        {/* 搜索行（预览 C4：输入框 bg-canvas） */}
        <div className="px-4 pb-2.5">
          <Input
            aria-label="搜索"
            placeholder={SEARCH_PLACEHOLDER[source]}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="bg-canvas"
          />
        </div>

        {/* 列表（预览 C7） */}
        <div className="flex-1 overflow-y-auto border-t border-subtle" onScroll={source === 'smithery' ? onListScroll : undefined}>
          {loading ? (
            <div className="py-8 text-center text-sm text-tertiary">加载中…</div>
          ) : error ? (
            <div className="flex flex-col items-center gap-2 py-8 text-sm text-status-error">
              <span>{error}</span>
              <Button size="sm" variant="secondary" onClick={() => void loadEntries()}>
                重试
              </Button>
            </div>
          ) : visibleEntries.length === 0 ? (
            <div className="py-8 text-center text-sm text-tertiary">
              {query.trim() !== '' ? '没有匹配的资源' : '目录为空'}
            </div>
          ) : (
            visibleEntries.map((entry) => {
              const state = rowState(entry);
              const local = installedVersions.get(localKey(entry));
              const busy = installing?.id === entry.item.id;
              // M5.0 §7.5 own 行免装：目录条目归属=本机 → 版本流恒为 本地→hub，
              // 不渲染安装/更新，改显「✓ 你的发布 · 本地 v{local} · 已发布 v{remote}」
              const ownPublish =
                source === 'hub' &&
                entry.ownerNodeId !== undefined &&
                entry.ownerNodeId === selfNodeId;
              return (
                <div
                  key={entry.id}
                  data-testid={`fetch-row-${entry.id}`}
                  className="flex items-center gap-3 border-b border-subtle px-4 py-[11px] last:border-b-0"
                >
                  <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-surface-3 text-[17px]">
                    {entry.item.iconEmoji ?? ''}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-[13.5px] font-semibold text-primary">{entry.name}</span>
                      <span className="text-[11.5px] tabular-nums text-tertiary">
                        {source === 'smithery'
                          ? `@${entry.item.marketplace?.author ?? ''}`
                          : entry.version !== undefined
                            ? `v${entry.version}`
                            : ''}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-tertiary">{entry.description}</div>
                    {source === 'hub' && (
                      <div className="mt-0.5 flex gap-2.5 text-[11.5px] text-tertiary">
                        {entry.item.marketplace?.author && <span>{entry.item.marketplace.author}</span>}
                        {entry.versionCount !== undefined && <span>{entry.versionCount} 个版本</span>}
                        {local !== undefined && local !== '' && <span>本地 v{local}</span>}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {ownPublish ? (
                      <span
                        data-testid="fetch-own-publish"
                        className="inline-flex items-center gap-1 text-[11.5px] text-status-success"
                      >
                        <Check size={12} strokeWidth={1.75} aria-hidden />
                        你的发布
                        {local !== undefined && local !== '' && ` · 本地 v${local}`}
                        {entry.version !== undefined && ` · 已发布 v${entry.version}`}
                      </span>
                    ) : (
                      <>
                    {state === 'install' && (
                      <button
                        type="button"
                        disabled={busy}
                        className="rounded-md bg-accent-500 px-[14px] py-1 text-[12.5px] font-medium text-inverse hover:opacity-90 disabled:opacity-50"
                        onClick={() => void handleInstall(entry)}
                      >
                        安装
                      </button>
                    )}
                    {state === 'blocked' && (
                      <span className="text-[11.5px] text-disabled">hosted 未部署 · 不可装</span>
                    )}
                    {state === 'update' && local !== undefined && (
                      <>
                        <span className="text-[11.5px] text-status-success">✓ 已装 v{local}</span>
                        <button
                          type="button"
                          disabled={busy}
                          className="rounded-md border border-accent-500 px-3 py-[3px] text-[12.5px] text-accent-600 hover:bg-surface-active disabled:opacity-50 dark:text-accent-300"
                          onClick={() => void handleInstall(entry)}
                        >
                          更新
                        </button>
                      </>
                    )}
                    {state === 'latest' && local !== undefined && (
                      <span className="text-[11.5px] text-disabled">✓ 已装 v{local} · 最新</span>
                    )}
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
          {source === 'smithery' && loadingMore && (
            <div className="py-2 text-center text-xs text-tertiary">加载更多…</div>
          )}
        </div>

        {/* smithery needsConfig 表单（预览无画面；两段安装的最小呈现——必填校验 + 提交） */}
        {configTarget && (
          <div className="border-t border-subtle px-4 py-3">
            <div className="mb-2 text-[13px] font-medium text-primary">
              配置「{configTarget.entry.name}」
            </div>
            <div className="flex flex-col gap-2">
              {Object.entries(configTarget.schema.properties ?? {}).map(([key, prop]) => (
                <label key={key} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-xs text-secondary">
                    {prop.title ?? key}
                    {(configTarget.schema.required ?? []).includes(key) ? ' *' : ''}
                  </span>
                  <Input
                    aria-label={prop.title ?? key}
                    value={configTarget.values[key] ?? ''}
                    onChange={(e) =>
                      setConfigTarget((cur) =>
                        cur ? { ...cur, values: { ...cur.values, [key]: e.target.value } } : cur,
                      )
                    }
                    className="bg-canvas"
                  />
                </label>
              ))}
            </div>
            {configError && <p className="mt-2 text-xs text-status-error">{configError}</p>}
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfigTarget(null)}>
                取消
              </Button>
              <Button onClick={() => void submitSmitheryConfig()}>安装</Button>
            </div>
          </div>
        )}

        {/* 脚注（预览 C14-C17：连接态 + hub 刷新入口 + 安装进度） */}
        <div className="flex items-center gap-2 border-t border-subtle px-4 py-2 text-[11.5px] text-tertiary">
          {source === 'hub' && (
            <button
              type="button"
              aria-label="刷新目录"
              className="flex text-tertiary hover:text-secondary"
              onClick={() => void loadEntries({ fresh: true })}
            >
              <RotateCw size={12} strokeWidth={1.75} aria-hidden />
            </button>
          )}
          <span>{footerText}</span>
          {installing && (
            <span className="ml-auto inline-flex items-center gap-1.5" data-testid="fetch-installing">
              正在安装「{installing.name}」…
              <span className="h-[3px] w-[120px] overflow-hidden rounded-sm bg-surface-3">
                <span
                  className={
                    installing.percent === null
                      ? 'block h-full w-full animate-pulse rounded-sm bg-accent-500'
                      : 'block h-full rounded-sm bg-accent-500'
                  }
                  style={installing.percent !== null ? { width: `${installing.percent}%` } : undefined}
                />
              </span>
              {installing.percent !== null && <span className="tabular-nums">{installing.percent}%</span>}
            </span>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
