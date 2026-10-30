// renderer/src/components/resource-library/TypePageShell.tsx
// 资源页公共骨架：单行工具栏（标题 + 搜索(flex) + 来源下拉(带计数) + AddMenu）
// + 已安装卡片网格（2026-10-23 卡片化：流式网格 minmax(240px,1fr)，随详情面板
// 拖宽/窗口缩放自动增减列）+ 右侧详情面板（可拖宽，280–560px，宽度持久化）。
// 四页同构，type 参数驱动。P2.3 起恒「已安装」单态；2026-10-09 组③：
// 工具栏改单行、来源筛选前端化（下拉计数需全量数据）、详情面板拖拽调宽、
// 加载失败加重试按钮。
// library-store-split（spec 2026-10-29 §2.1）：库页收窄为纯本地实体——来源下拉
// 只剩 全部/系统预置/自定义 三档；外部市场弹层与三条提示横幅（hub 未接入灰条 /
// hub 降级黄条 / 市场降级黄条）随退场，语义迁 FetchDialog 特殊态；远端获取收进
// AddMenu 远端组。
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { BuiltinPresetPreview, DefinitionImpact, ResourceItem, ResourceType } from '../../ipc/types';
import { ipc } from '../../ipc/client';
import { useSessionStore } from '../../stores/session.store';
import { useResourceStore } from '../../stores/resource.store';
import { useHubStore } from '../../stores/hub.store';
import { useUiStore } from '../../stores/ui.store';
import { hasKnownErrorPrefix } from '../../lib/error-prefix';
import { EmptyState } from '../ui/EmptyState';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { Dialog } from '../ui/Dialog';
import { AddMenu } from './AddMenu';
import type { AddMenuItem } from './AddMenu';
import { DanglingRefsCard } from './DanglingRefsCard';
import { ResourceCard } from './ResourceCard';
import { TYPE_ICON } from './type-icons';
import { ResourceDetail } from './ResourceDetail';
import { ConfirmDialog } from '../ui/ConfirmDialog';

/**
 * 来源下拉选项（library-store-split 预览 §A 定值：仅本地三档）。
 * marketplace / smithery / hub 已装条目计入「全部」总数（无专属档）；
 * 未装远端条目不再进入库页（resource:list 收窄）。
 */
const SOURCE_OPTIONS: ReadonlyArray<{ key: SourceOptionKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'builtin', label: '系统预置' },
  { key: 'custom', label: '自定义' },
];

/** 来源计数形状（与 SOURCE_OPTIONS 的 key 一一对应；其余来源只计入 all） */
interface SourceCounts {
  all: number;
  builtin: number;
  custom: number;
}

type SourceOptionKey = keyof SourceCounts;

/** 每类页的空态标题（spec §7） */
const EMPTY_COPY: Record<ResourceType, string> = {
  agent: '还没有智能体',
  mcp: '还没有 MCP 服务器',
  skill: '还没有技能',
  plugin: '还没有安装插件',
};

/** 每类页工具栏标题（冒烟修复：原内联三元漏 plugin 分支落入「技能」） */
const PAGE_TITLE: Record<ResourceType, string> = {
  agent: '智能体',
  mcp: 'MCP 服务器',
  skill: '技能',
  plugin: '插件',
};

/** 每类页的 AddMenu 按钮文案（lucide Plus 图标单独承担「+」语义） */
const ADD_LABEL: Record<ResourceType, string> = {
  agent: '新建 / 导入',
  mcp: '添加服务器',
  skill: '添加技能',
  plugin: '安装插件',
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
    lines.push(`· 从 ${impact.memberCount} 个工作空间移出该智能体（${impact.workspaceNames.join('、')}）`);
  }
  if (impact.ledTeamNames.length > 0) {
    lines.push(`· 解散 ${impact.ledTeamNames.length} 个团队（该智能体为 leader：${impact.ledTeamNames.join('、')}）`);
  }
  if (impact.readOnlySessionCount > 0) {
    lines.push(`· ${impact.readOnlySessionCount} 个会话的全部成员失效，将变为只读（消息历史保留）`);
  }
  if (impact.defaultForWorkspaceNames.length > 0) {
    lines.push(`· 清空 ${impact.defaultForWorkspaceNames.length} 个工作空间的默认智能体设置`);
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
  /** 本地安装回调（installed 列表 installable 项；实现直连 store.installResource） */
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
  /** 插件启停入口（workspace 级；View 层接 store.setPluginEnabled，spec 2026-10-15 §7.1） */
  onTogglePlugin?: (item: ResourceItem, next: boolean) => void;
  /** 插件重载入口（View 层接 ipc.plugin.reload，P2 §3.3） */
  onReloadPlugin?: (item: ResourceItem) => void;
  /** builtin agent 薄 fork 入口（AgentCreateWizard 预填挂载在 View 层；2026-10-08） */
  onForkPreset?: (preview: BuiltinPresetPreview) => void;
  /** builtin agent 停用入口（2026-10-10 披露式级联：View 层挂影响面确认框） */
  onDisableAgent?: (id: string) => void;
  /** 发布到 momo-hub 入口（M2.2 Task 2 起 canPublishToHub 门控：custom 四类型 + marketplace 已装 skill）；PublishDialog 挂在 View 层 */
  onPublishToHub?: (item: ResourceItem) => void;
  /** 从 momo-hub 下架入口（M3.4 §2.4）：仅 hub 来源卡渲染（门控在 ResourceCard）；toast 反馈在 View 层 */
  onUnpublishFromHub?: (item: ResourceItem) => void;
}

export function TypePageShell({ type, addItems, onInstall, onEditAgent, onOpenPreset, onEditMcpConfig, onEditMcpEntry, onToggleMcp, onTogglePlugin, onReloadPlugin, onForkPreset, onDisableAgent, onPublishToHub, onUnpublishFromHub }: TypePageShellProps) {
  const {
    items, loading, error, installNotice, hubUpdates, hubSeeded, sourceFilter, query,
    setSourceFilter, setQuery, deleteResource, load, loadCatalogStatus, loadHubOwnership,
    hubOwnership, hubOwnershipKnown, hubSelfNodeId,
  } = useResourceStore();
  const setActiveView = useUiStore((s) => s.setActiveView);
  // hub 接入态（发布入口门控；hubDegraded/hubNotEnrolled 的提示条已随
  // library-store-split 退场——降级/未接入语义迁 FetchDialog 特殊态）
  const hubStatus = useHubStore((s) => s.status);
  const hubEnrolled = hubStatus !== null && hubStatus.configured && hubStatus.nodeId !== null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ResourceItem | null>(null);
  /** 插件卸载目标（keepData 双按钮弹窗，spec §7.2——与通用删除确认分流） */
  const [pendingPluginDelete, setPendingPluginDelete] = useState<ResourceItem | null>(null);
  /** agent 删除的影响面（披露式级联确认文案）；null = 非 agent 或预查失败回落通用文案 */
  const [deleteImpact, setDeleteImpact] = useState<DefinitionImpact | null>(null);
  const [detailWidth, setDetailWidth] = useState<number>(readInitialDetailWidth);
  const Icon = TYPE_ICON[type];

  // D9：catalog 只影响 agent 预置目录的远程部分——agent 页探测 marketplace 降级；
  // M1 Task 14 起 hub 页签可从任意类型页进入，hub 目录降级态（hubDegraded）同探。
  // M5.0：归属快照同拍拉取（徽标/发布钮/下架钮收敛判定输入）。
  useEffect(() => {
    void loadCatalogStatus();
    if (!hubOwnershipKnown) void loadHubOwnership();
  }, [loadCatalogStatus, loadHubOwnership, hubOwnershipKnown]);

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
   *  agent 类型先做影响面预查（披露式级联），预查失败回落通用文案不阻断删除。
   *  plugin 类型分流到 keepData 双按钮卸载弹窗（spec 2026-10-15 §7.2）。 */
  const requestDelete = (id: string): void => {
    const item = items.find((i) => i.id === id);
    if (!item) {
      void deleteResource(id); // 列表已无此行（竞态兜底）——直删
      return;
    }
    if (item.type === 'plugin') {
      setPendingPluginDelete(item);
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

  /** 插件卸载执行（keepData 双按钮弹窗确认后）：失败落 error 红条，成功横幅 + 刷新 */
  const doPluginUninstall = async (item: ResourceItem, keepData: boolean): Promise<void> => {
    setPendingPluginDelete(null);
    try {
      await ipc.plugin.uninstall(item.slug, keepData);
      useResourceStore.setState({ installNotice: `已卸载「${item.name}」` });
      if (selectedId === item.id) setSelectedId(null);
      await load();
    } catch (err) {
      useResourceStore.setState({
        error: `卸载失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
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

  // 来源计数（下拉选项标签；marketplace/smithery/hub 已装条目只计入 all）
  const counts: SourceCounts = { all: items.length, builtin: 0, custom: 0 };
  for (const i of items) {
    if (i.source === 'builtin') counts.builtin += 1;
    else if (i.source === 'custom') counts.custom += 1;
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
          {PAGE_TITLE[type]}
        </h2>
        <div className="flex-1 min-w-0">
          <Input placeholder="搜索名称 / 描述 / slug…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select
          aria-label="来源筛选"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as SourceOptionKey)}
          className="w-32 py-1.5 shrink-0"
        >
          {SOURCE_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label} {counts[o.key]}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-2 shrink-0">
          <AddMenu label={ADD_LABEL[type]} items={addItems} />
        </div>
      </div>

      {/* 一次性成功横幅（本地导入/安装反馈）。D13：对象形态带「去会话」CTA
          （actionView=目标视图 key；当前唯一写入方 EnablePresetDialog 传 'im'） */}
      {installNotice && (
        <div data-testid="install-notice" className="mx-4 mt-3 px-3 py-2 rounded-md border border-subtle bg-status-success-tint text-status-success text-sm inline-flex items-center gap-1.5 self-start">
          <span>{typeof installNotice === 'string' ? installNotice : installNotice.text}</span>
          {(() => {
            const view = typeof installNotice === 'object' ? installNotice.actionView : undefined;
            return view ? (
              <Button size="sm" onClick={() => setActiveView(view)}>
                去会话
              </Button>
            ) : null;
          })()}
        </div>
      )}

      {/* library-store-split：hub 未接入 / hub 降级 / 市场目录降级三条横幅已退场
          （语义迁 FetchDialog 特殊态，spec §2.1） */}

      {/* MCP 悬空引用提示卡（spec §6.3）——仅 MCP 页挂载；空/null 静默不渲染 */}
      {type === 'mcp' && <DanglingRefsCard />}

      {/* 主区 */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* store 错误行（导入/删除等写操作失败反馈）+ 重试（组③：失败不止红字） */}
          {error && (
            <div className="flex items-center justify-center gap-2 py-2 text-status-error text-sm">
              <span>{hasKnownErrorPrefix(error) ? error : `加载失败：${error}`}</span>
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
            // 流式网格（2026-10-23 卡片化 P1 预览批准定值）：minmax(240px,1fr)
            // auto-fill——列数随容器宽度自动增减；content-start 防 auto 行在
            // 高容器下被 align-content:stretch 拉伸铺满整屏
            <div role="list" aria-label="资源列表" className="flex-1 overflow-auto p-3 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2 content-start">
              {filteredItems.map((item) => (
                <ResourceCard
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
                  onTogglePlugin={onTogglePlugin}
                  onPublishToHub={onPublishToHub}
                  onUnpublishFromHub={onUnpublishFromHub}
                  hubEnrolled={hubEnrolled}
                  hubUpdates={hubUpdates}
                  hubSeeded={hubSeeded[item.type] === true}
                  hubOwnership={hubOwnership[`${item.type}:${item.slug}`]}
                  hubSelfNodeId={hubSelfNodeId}
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
              onTogglePlugin={onTogglePlugin}
              onReloadPlugin={onReloadPlugin}
              onForkPreset={onForkPreset}
              onDisable={onDisableAgent}
              onPublishToHub={onPublishToHub}
              hubEnrolled={hubEnrolled}
              hubOwnership={hubOwnership[`${selected.type}:${selected.slug}`]}
              hubSelfNodeId={hubSelfNodeId}
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
              ? '此操作不可撤销。引用它的智能体将出现悬空提示，需手动移除引用。'
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

      {/* 插件卸载弹窗（spec 2026-10-15 §7.2）：keepData 双按钮——完全卸载删数据目录，
          保留数据留待重装。dev 源卸载只解除注册（用户源目录不动）。 */}
      {pendingPluginDelete && (
        <Dialog open onClose={() => setPendingPluginDelete(null)} title="卸载插件" width={400}>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-primary">
              卸载「{pendingPluginDelete.name}
              {pendingPluginDelete.version ? ` v${pendingPluginDelete.version}` : ''}」？
            </p>
            <p className="text-xs text-tertiary">
              {pendingPluginDelete.plugin?.devSource
                ? 'dev 源插件：仅解除注册，你的源码目录不受影响。'
                : '注册与安装副本将被移除；是否保留插件数据目录（索引缓存等）？'}
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={() => setPendingPluginDelete(null)}>
                取消
              </Button>
              <Button
                variant="ghost"
                type="button"
                onClick={() => void doPluginUninstall(pendingPluginDelete, true)}
              >
                卸载并保留数据
              </Button>
              <Button
                variant="danger"
                type="button"
                onClick={() => void doPluginUninstall(pendingPluginDelete, false)}
              >
                完全卸载
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
