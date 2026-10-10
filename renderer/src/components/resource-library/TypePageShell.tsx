// renderer/src/components/resource-library/TypePageShell.tsx
// 资源页公共骨架：单行工具栏（标题 + 搜索(flex) + 来源下拉(带计数) + 外部市场 +
// AddMenu）+ 已安装行列表 + 右侧详情面板（可拖宽，280–560px，宽度持久化）。
// 三页同构，type 参数驱动。P2.3 起恒「已安装」单态；2026-10-09 组③：
// 工具栏改单行（原 chips 在窄窗折行 95px，走查 B10 方案 B）、来源筛选前端化
// （下拉计数需全量数据）、详情面板 B8 方案 B 拖拽调宽、加载失败加重试按钮。
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { BuiltinPresetPreview, DefinitionImpact, ResourceItem, ResourceSource, ResourceType } from '../../ipc/types';
import { ipc } from '../../ipc/client';
import { useSessionStore } from '../../stores/session.store';
import { useResourceStore } from '../../stores/resource.store';
import { EmptyState } from '../ui/EmptyState';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { AddMenu } from './AddMenu';
import type { AddMenuItem } from './AddMenu';
import { ExternalMarketplacePopover } from './ExternalMarketplacePopover';
import { DanglingRefsCard } from './DanglingRefsCard';
import { ResourceRow, TYPE_ICON } from './ResourceRow';
import { ResourceDetail } from './ResourceDetail';
import { ConfirmDialog } from '../ui/ConfirmDialog';

/**
 * 来源下拉选项（组③ B10 方案 B）。marketplace / smithery 不设选项：P2.3 起 UI
 * 无网络安装入口，两源在新装实例永远 0 行——死入口只制造误导（走查 N4）。
 * 历史安装项计入「全部来源」总数，徽章保留来源标识。
 */
const SOURCE_OPTIONS: ReadonlyArray<{ key: SourceOptionKey; label: string }> = [
  { key: 'all', label: '全部来源' },
  { key: 'builtin', label: '预置' },
  { key: 'custom', label: '自定义' },
  { key: 'p2p', label: 'P2P' },
];

/** 来源计数形状（与 SOURCE_OPTIONS 的 key 一一对应；其余来源只计入 all） */
interface SourceCounts {
  all: number;
  builtin: number;
  custom: number;
  p2p: number;
}

type SourceOptionKey = keyof SourceCounts;

/** 每类页的空态标题（spec §7） */
const EMPTY_COPY: Record<ResourceType, string> = {
  agent: '还没有智能体',
  mcp: '还没有 MCP 服务器',
  skill: '还没有技能',
};

/** 每类页的 AddMenu 按钮文案（lucide Plus 图标单独承担「+」语义） */
const ADD_LABEL: Record<ResourceType, string> = {
  agent: '新建 / 导入',
  mcp: '添加服务器',
  skill: '添加技能',
};

const DETAIL_WIDTH_KEY = 'momo.resourceLibrary.detailWidth';
const DETAIL_WIDTH_MIN = 280;
const DETAIL_WIDTH_MAX = 560;
const DETAIL_WIDTH_DEFAULT = 384;

const clampDetailWidth = (w: number): number => Math.min(DETAIL_WIDTH_MAX, Math.max(DETAIL_WIDTH_MIN, w));

/** agent 删除/停用披露文案（2026-10-10 披露式级联）——影响面行只列非零项；
 *  impact 为 null（预查失败）时仅返回 base。导出供单测锁文案契约。 */
export function buildImpactMessage(base: string, impact: DefinitionImpact | null): string {
  if (!impact) return base;
  const lines: string[] = [];
  if (impact.memberCount > 0) {
    lines.push(`· 从 ${impact.memberCount} 个工作空间移出该 agent（${impact.workspaceNames.join('、')}）`);
  }
  if (impact.ledTeamNames.length > 0) {
    lines.push(`· 解散 ${impact.ledTeamNames.length} 个团队（该 agent 为 leader：${impact.ledTeamNames.join('、')}）`);
  }
  if (impact.readOnlySessionCount > 0) {
    lines.push(`· ${impact.readOnlySessionCount} 个会话的全部成员失效，将变为只读（消息历史保留）`);
  }
  if (impact.defaultForWorkspaceNames.length > 0) {
    lines.push(`· 清空 ${impact.defaultForWorkspaceNames.length} 个工作空间的默认 agent 设置`);
  }
  return lines.length > 0 ? `${base}\n${lines.join('\n')}` : base;
}

/** 启动恢复上次详情面板宽度（失效值回退默认；隐私模式读写异常不影响内存态） */
function readInitialDetailWidth(): number {
  try {
    const raw = Number.parseInt(localStorage.getItem(DETAIL_WIDTH_KEY) ?? '', 10);
    if (Number.isFinite(raw)) return clampDetailWidth(raw);
  } catch {
    // 忽略
  }
  return DETAIL_WIDTH_DEFAULT;
}

interface TypePageShellProps {
  type: ResourceType;
  /** 类型专属「＋」下拉项（由 ResourceLibraryView 组装——弹窗开关都在那边） */
  addItems: AddMenuItem[];
  /** 本地安装回调（installed 列表 installable 项——p2p 导入；实现直连 store.installResource） */
  onInstall: (id: string) => void;
  /** custom agent 编辑入口（DefinitionEditor 挂载在 View 层） */
  onEditAgent: (id: string) => void;
  /** builtin/marketplace agent 启用/配置入口（EnablePresetDialog 挂载在 View 层） */
  onOpenPreset: (id: string) => void;
  /** 已装远程 MCP 配置编辑入口（McpConfigDialog 挂载在 View 层；P2.2 Task 7） */
  onEditMcpConfig?: (item: ResourceItem) => void;
  /** 已装 custom MCP 全字段编辑入口（RegisterMcpDialog edit 模式挂载在 View 层；P2.5 Task 3） */
  onEditMcpEntry?: (item: ResourceItem) => void;
  /** 组⑤：MCP 启停入口（View 层接 store.setMcpEnabled） */
  onToggleMcp?: (item: ResourceItem, next: boolean) => void;
  /** builtin agent 薄 fork 入口（AgentCreateWizard 预填挂载在 View 层；2026-10-08） */
  onForkPreset?: (preview: BuiltinPresetPreview) => void;
  /** builtin agent 停用入口（2026-10-10 披露式级联：View 层挂影响面确认框） */
  onDisableAgent?: (id: string) => void;
}

export function TypePageShell({ type, addItems, onInstall, onEditAgent, onOpenPreset, onEditMcpConfig, onEditMcpEntry, onToggleMcp, onForkPreset, onDisableAgent }: TypePageShellProps) {
  const {
    items, loading, error, installNotice, sourceFilter, query,
    setSourceFilter, setQuery, deleteResource, load,
  } = useResourceStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ResourceItem | null>(null);
  /** agent 删除的影响面（披露式级联确认文案）；null = 非 agent 或预查失败回落通用文案 */
  const [deleteImpact, setDeleteImpact] = useState<DefinitionImpact | null>(null);
  const [detailWidth, setDetailWidth] = useState<number>(readInitialDetailWidth);
  const Icon = TYPE_ICON[type];

  // ── 详情面板拖宽（组③ B8 方案 B）：手柄在面板左缘，鼠标左移 = 变宽 ──────
  const widthRef = useRef(detailWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const persistDetailWidth = useCallback((): void => {
    try {
      localStorage.setItem(DETAIL_WIDTH_KEY, String(widthRef.current));
    } catch {
      // 忽略
    }
  }, []);

  const applyWidth = useCallback((w: number): void => {
    const clamped = clampDetailWidth(w);
    widthRef.current = clamped;
    setDetailWidth(clamped);
  }, []);

  const onDragMove = useCallback((e: globalThis.MouseEvent): void => {
    const drag = dragRef.current;
    if (!drag) return;
    applyWidth(drag.startWidth + (drag.startX - e.clientX));
  }, [applyWidth]);

  const endDrag = useCallback((): void => {
    if (dragRef.current !== null) persistDetailWidth();
    dragRef.current = null;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', endDrag);
  }, [onDragMove, persistDetailWidth]);

  // 拖拽中途卸载（切页等）——摘掉 document 监听防泄漏
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', endDrag);
    };
  }, [onDragMove, endDrag]);

  const beginDrag = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: widthRef.current };
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', endDrag);
  };

  /** 键盘调宽（无鼠标路径）：←/→ ±16（Shift ×3），Home/End 到边界 */
  const onGripKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 48 : 16;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = widthRef.current + step;
    else if (e.key === 'ArrowRight') next = widthRef.current - step;
    else if (e.key === 'Home') next = DETAIL_WIDTH_MIN;
    else if (e.key === 'End') next = DETAIL_WIDTH_MAX;
    if (next === null) return;
    e.preventDefault();
    applyWidth(next);
    persistDetailWidth();
  };

  /** 拦截行/详情删除 → 二次确认（P2.5 D5；三类型统一）。
   *  agent 类型先做影响面预查（披露式级联），预查失败回落通用文案不阻断删除。 */
  const requestDelete = (id: string): void => {
    const item = items.find((i) => i.id === id);
    if (!item) {
      void deleteResource(id); // 列表已无此行（竞态兜底）——直删
      return;
    }
    if (item.type === 'agent') {
      // defId 口径：custom agent 资源 slug = def.id（与 View 层 handleEditAgent 同口径）
      void ipc.agent
        .definitionImpact(item.slug)
        .then((impact) => {
          setDeleteImpact(impact);
          setPendingDelete(item);
        })
        .catch(() => {
          setDeleteImpact(null);
          setPendingDelete(item);
        });
      return;
    }
    setDeleteImpact(null);
    setPendingDelete(item);
  };

  // 前端过滤（搜索与来源筛选同语义，内存过滤——来源计数需全量 items）
  const q = query.trim().toLowerCase();
  const filteredItems = items.filter((i) => {
    if (sourceFilter !== 'all' && i.source !== sourceFilter) return false;
    if (
      q &&
      !i.name.toLowerCase().includes(q) &&
      !i.description.toLowerCase().includes(q) &&
      !i.slug.toLowerCase().includes(q)
    ) {
      return false;
    }
    return true;
  });
  // 有搜索词或来源筛选 = 「过滤视图」；空结果须与「真空库」区分（走查 A2/N6）
  const hasActiveFilter = q !== '' || sourceFilter !== 'all';
  const clearFilter = (): void => {
    setQuery('');
    setSourceFilter('all');
  };

  // 来源计数（下拉选项标签；marketplace/smithery 只计入 all）
  const counts: SourceCounts = { all: items.length, builtin: 0, custom: 0, p2p: 0 };
  for (const i of items) {
    if (i.source === 'builtin') counts.builtin += 1;
    else if (i.source === 'custom') counts.custom += 1;
    else if (i.source === 'p2p') counts.p2p += 1;
  }

  // 详情数据：从「过滤后」列表解析——选中项被搜索/筛选排除时详情面板自动收起
  // （走查 N2：空态与详情同屏矛盾）。删除后 items 更新同样让 selected 失效收起。
  const selected = selectedId ? filteredItems.find((i) => i.id === selectedId) : undefined;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 工具栏（组③ B10 方案 B：单行——标题 / 搜索(flex 自适应) / 来源下拉 / 动作） */}
      <div className="px-4 py-2.5 border-b border-subtle flex items-center gap-2 min-w-0">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-primary shrink-0">
          <Icon size={14} strokeWidth={1.75} aria-hidden />
          {type === 'agent' ? '智能体' : type === 'mcp' ? 'MCP 服务器' : '技能'}
        </h2>
        <div className="flex-1 min-w-0">
          <Input placeholder="搜索名称 / 描述 / slug…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select
          aria-label="来源筛选"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as ResourceSource | 'all')}
          className="w-32 py-1.5 shrink-0"
        >
          {SOURCE_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label} {counts[o.key]}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-2 shrink-0">
          {/* 外部市场快捷打开（P2.3 spec §4） */}
          <ExternalMarketplacePopover type={type} />
          <AddMenu label={ADD_LABEL[type]} items={addItems} />
        </div>
      </div>

      {/* 一次性成功横幅（本地导入/安装反馈） */}
      {installNotice && (
        <div data-testid="install-notice" className="mx-4 mt-3 px-3 py-2 rounded-md border border-subtle bg-status-success-tint text-status-success text-sm inline-flex items-center gap-1.5 self-start">
          {installNotice}
        </div>
      )}

      {/* MCP 悬空引用提示卡（spec §6.3）——仅 MCP 页挂载；空/null 静默不渲染 */}
      {type === 'mcp' && <DanglingRefsCard />}

      {/* 主区 */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* store 错误行（导入/删除等写操作失败反馈）+ 重试（组③：失败不止红字） */}
          {error && (
            <div className="flex items-center justify-center gap-2 py-2 text-status-error text-sm">
              <span>加载失败：{error}</span>
              <Button size="sm" variant="secondary" onClick={() => void load()}>
                重试
              </Button>
            </div>
          )}
          {loading && items.length === 0 ? (
            <div className="text-center text-tertiary text-sm py-8">加载中…</div>
          ) : filteredItems.length === 0 ? (
            hasActiveFilter ? (
              <EmptyState
                icon={Icon}
                title="没有匹配的资源"
                description="换个关键词，或清除来源筛选再试"
                action={
                  <Button size="sm" variant="secondary" onClick={clearFilter}>
                    清除筛选
                  </Button>
                }
              />
            ) : (
              <EmptyState icon={Icon} title={EMPTY_COPY[type]} description="从右上角「＋」选择添加方式" />
            )
          ) : (
            <div role="list" aria-label="资源列表" className="flex-1 overflow-auto p-4 flex flex-col gap-1.5">
              {filteredItems.map((item) => (
            <ResourceRow
              key={item.id}
              item={item}
              selected={selectedId === item.id}
              onSelect={setSelectedId}
              onInstall={onInstall}
              onDelete={requestDelete}
              onEnable={onOpenPreset}
              onEdit={onEditAgent}
              onConfigure={onOpenPreset}
              onDisable={onDisableAgent}
            />
              ))}
            </div>
          )}
        </div>

        {/* 右侧详情面板（条件渲染；宽度可拖，组③ B8 方案 B） */}
        {selected && (
          <div data-testid="detail-pane" className="relative shrink-0" style={{ width: detailWidth }}>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整详情面板宽度"
              tabIndex={0}
              className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-surface-active focus-visible:bg-surface-active"
              onMouseDown={beginDrag}
              onKeyDown={onGripKeyDown}
            />
            <ResourceDetail
              item={selected}
              onClose={() => setSelectedId(null)}
              onInstall={onInstall}
              onDelete={requestDelete}
              onEdit={onEditAgent}
              onEnable={onOpenPreset}
              onConfigure={onOpenPreset}
              onEditMcpConfig={onEditMcpConfig}
              onEditMcpEntry={onEditMcpEntry}
              onToggleMcp={onToggleMcp}
              onForkPreset={onForkPreset}
              onDisable={onDisableAgent}
            />
          </div>
        )}
      </div>

      {/* 删除二次确认弹窗（P2.5 D5）：确认才执行 deleteResource。
          agent 类型带影响面披露（2026-10-10 披露式级联） */}
      {pendingDelete && (
        <ConfirmDialog
          title={`删除 ${pendingDelete.name}？`}
          message={
            pendingDelete.type === 'mcp'
              ? '此操作不可撤销。引用它的 agent 将出现悬空提示，需手动移除引用。'
              : pendingDelete.type === 'agent' && deleteImpact
                ? buildImpactMessage('此操作不可撤销。将同时：', deleteImpact)
                : '此操作不可撤销。'
          }
          confirmLabel="确认删除"
          onConfirm={() => {
            const wasAgent = pendingDelete.type === 'agent';
            void deleteResource(pendingDelete.id).then(() => {
              // agent 删除级联可能清空会话成员 → 刷新会话面（readOnly 不等发消息）
              if (!wasAgent) return;
              const ss = useSessionStore.getState();
              ss.pullSessionList();
              if (ss.activeSessionId) void ss.loadMembers(ss.activeSessionId);
            });
          }}
          onClose={() => {
            setPendingDelete(null);
            setDeleteImpact(null);
          }}
        />
      )}
    </div>
  );
}
