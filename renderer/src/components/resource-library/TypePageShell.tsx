// renderer/src/components/resource-library/TypePageShell.tsx
// 资源页公共骨架（spec §2.1）：工具栏（搜索 + 来源 chips + AddMenu + 模式 Segmented）
// + 已安装行列表 / RegistryBrowse + 右侧详情面板。三页同构，type 参数驱动。
import { useState } from 'react';
import type { ResourceFilter, ResourceSource, ResourceType } from '../../ipc/types';
import { useResourceStore } from '../../stores/resource.store';
import { EmptyState } from '../ui/EmptyState';
import { Input } from '../ui/Input';
import { Segmented } from '../ui/Segmented';
import { cn } from '../../lib/cn';
import { AddMenu } from './AddMenu';
import type { AddMenuItem } from './AddMenu';
import { RegistryBrowse } from './RegistryBrowse';
import { ResourceRow, TYPE_ICON } from './ResourceRow';
import { ResourceDetail } from './ResourceDetail';

/** 来源筛选 chips（'all' = 不限） */
const SOURCE_CHIPS: Array<{ key: ResourceFilter['source'] | 'all'; label: string }> = [
  { key: 'all', label: '全部来源' },
  { key: 'builtin', label: '预置' },
  { key: 'custom', label: '自定义' },
  { key: 'marketplace', label: '网络' },
  { key: 'p2p', label: 'P2P' },
];

/** 每类页的空态标题（spec §7） */
const EMPTY_COPY: Record<ResourceType, string> = {
  agent: '还没有智能体',
  mcp: '还没有 MCP 服务器',
  skill: '还没有技能',
};

const MODE_OPTIONS = [
  { value: 'installed', label: '已安装' },
  { value: 'registry', label: '网络获取' },
] as const;

/** 每类页的 AddMenu 按钮文案（lucide Plus 图标单独承担「+」语义） */
const ADD_LABEL: Record<ResourceType, string> = {
  agent: '新建 / 导入',
  mcp: '添加服务器',
  skill: '添加技能',
};

interface TypePageShellProps {
  type: ResourceType;
  /** 类型专属「＋」下拉项（由 ResourceLibraryView 组装——弹窗开关都在那边） */
  addItems: AddMenuItem[];
  /** 安装包装（marketplace agent 成功后弹配置引导——逻辑在 View 层） */
  onInstall: (id: string) => void;
  /** custom agent 编辑入口（DefinitionEditor 挂载在 View 层） */
  onEditAgent: (id: string) => void;
  /** builtin/marketplace agent 启用/配置入口（EnablePresetDialog 挂载在 View 层） */
  onOpenPreset: (id: string) => void;
}

export function TypePageShell({ type, addItems, onInstall, onEditAgent, onOpenPreset }: TypePageShellProps) {
  const {
    items, loading, error, installNotice, sourceFilter, query, mode,
    setSourceFilter, setQuery, setMode, deleteResource,
  } = useResourceStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const Icon = TYPE_ICON[type];

  // 详情数据：删除后 items 更新可能让 selected 失效 → 自动收起（沿用原 View 语义）
  const selected = selectedId ? items.find((i) => i.id === selectedId) : undefined;

  // 前端搜索过滤（与原 View 同语义：name/description/slug 模糊匹配）
  const q = query.trim().toLowerCase();
  const filteredItems = q
    ? items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          i.slug.toLowerCase().includes(q),
      )
    : items;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 工具栏 */}
      <div className="px-4 py-2.5 border-b border-subtle flex items-center gap-2 flex-wrap">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-primary">
          <Icon size={14} strokeWidth={1.75} aria-hidden />
          {type === 'agent' ? '智能体' : type === 'mcp' ? 'MCP 服务器' : '技能'}
        </h2>
        {/* 外层搜索仅已安装模式渲染——registry 模式由 RegistryBrowse 自带搜索框（防双搜索框） */}
        {mode === 'installed' && (
          <div className="w-56">
            <Input placeholder="搜索名称 / 描述 / slug…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        )}
        {mode === 'installed' &&
          SOURCE_CHIPS.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={cn(
                'text-xs px-2 py-0.5 rounded-full transition-colors',
                sourceFilter === chip.key
                  ? 'bg-surface-active text-accent-600 dark:text-accent-300'
                  : 'bg-surface-3 text-secondary hover:bg-surface-active',
              )}
              onClick={() => setSourceFilter(chip.key as ResourceSource | 'all')}
            >
              {chip.label}
            </button>
          ))}
        <div className="ml-auto flex items-center gap-2">
          <Segmented options={MODE_OPTIONS} value={mode} onChange={(v) => setMode(v)} aria-label="列表模式" />
          <AddMenu label={ADD_LABEL[type]} items={addItems} />
        </div>
      </div>

      {/* 一次性成功横幅（双模式渲染——registry 安装成功同样可见，终审 Important-1） */}
      {installNotice && (
        <div data-testid="install-notice" className="mx-4 mt-3 px-3 py-2 rounded-md border border-subtle bg-status-success-tint text-status-success text-sm inline-flex items-center gap-1.5 self-start">
          {installNotice}
        </div>
      )}

      {/* 主区 */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* store 错误行（双模式渲染——registry 安装失败同样可见；RegistryBrowse 的
              Provider 拉取错误仍由其内部分支自渲染，终审 Important-1） */}
          {error && <div className="text-center text-status-error text-sm py-2">加载失败：{error}</div>}
          {mode === 'registry' ? (
            <RegistryBrowse type={type} onInstall={onInstall} />
          ) : loading && items.length === 0 ? (
            <div className="text-center text-tertiary text-sm py-8">加载中…</div>
          ) : filteredItems.length === 0 ? (
            <EmptyState icon={Icon} title={EMPTY_COPY[type]} description="从右上角「＋」选择添加方式" />
          ) : (
            <div className="flex-1 overflow-auto p-4 flex flex-col gap-1.5">
              {filteredItems.map((item) => (
                <ResourceRow
                  key={item.id}
                  item={item}
                  selected={selectedId === item.id}
                  onSelect={setSelectedId}
                  onInstall={onInstall}
                  onDelete={deleteResource}
                  onEnable={onOpenPreset}
                  onEdit={onEditAgent}
                  onConfigure={onOpenPreset}
                />
              ))}
            </div>
          )}
        </div>

        {/* 右侧详情面板（条件渲染；Task 15 升级三段式，props 不变） */}
        {mode === 'installed' && selected && (
          <ResourceDetail
            item={selected}
            onClose={() => setSelectedId(null)}
            onInstall={onInstall}
            onDelete={deleteResource}
            onEdit={onEditAgent}
            onEnable={onOpenPreset}
            onConfigure={onOpenPreset}
          />
        )}
      </div>
    </div>
  );
}
