// renderer/src/components/im/RoomList.tsx
//
// 2026-10-22 Task 7（spec 2026-10-22 §4，预览 A 三轮批准定值）：
// - 分桶渲染：置顶区（无组头）→ 分组区（组头 + 组内项，组序 = groups position）→
//   未分组项；sessions 数组即主进程全局序，桶内顺序原样保持（不本地 sort）
// - 行内类型图标（deriveSessionType：Zap/Users/ListTodo）；成员身份图标仍全线
//   不渲染（v2.2 语义不变——身份信息在会话面板成员区查看）
// - 置顶行右侧恒显 Pin（10px）；hover 工具条四裸钮（置顶/移动到分组/重命名/解散）
// - 组头：整行组色 tint（rgba .13 浅 / .20 暗，hover 不加深仅浮现操作钮）+
//   ChevronDown/Right 折叠（localStorage 按工作空间持久化）+ Palette·Pencil·Trash2
// - Palette 面板（原地展开，零文字）：6 色板 swatch + 恢复默认（色板[组序 % 6]）
//   + ＋自定义（hex 输入，trim 后 setColor——堵 regex $ 尾换行洞）
// - 搜索拍平态：无组头无置顶区结构，平铺行保留类型图标 + Pin + 组色圆点 + 组名后缀
//
// 既有语义保留：标题搜索过滤 / 重命名 PromptDialog / 解散 ConfirmDialog /
// 空态 EmptyState / 切 workspace 清过滤。写面一律直调 ipc + refreshSessionList
// （不新增 store action，与 rename/delete 先例一致）。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useSessionStore } from '../../stores/session.store';
import { useUiStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useThemeStore } from '../../stores/theme.store';
import { ipc } from '../../ipc/client';
import { PromptDialog } from '../common/PromptDialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { cn } from '../../lib/cn';
import { deriveSessionType, type SessionType } from '../../lib/session-type';
import {
  groupBorderColor,
  groupDotColor,
  groupTintColor,
  type GroupColorTheme,
} from '../../lib/group-colors';
import { MoveToGroupDialog } from './MoveToGroupDialog';
import { SessionGroupColorPopover } from './SessionGroupColorPopover';
import { BatchSessionContextMenu, GroupContextMenu, SessionContextMenu } from './SessionContextMenu';
import { DefaultAgentPickerDialog } from './DefaultAgentPickerDialog';
import { CollabSessionDialog } from './CollabSessionDialog';
import type { SessionGroupRow, SessionSummary } from '../../ipc/types';
import {
  ChevronDown,
  ChevronRight,
  Crosshair,
  FolderPlus,
  ListTodo,
  MessageSquare,
  Pin,
  Search,
  Users,
  X,
  Zap,
} from 'lucide-react';

const TYPE_ICON: Record<SessionType, { Icon: typeof Zap; label: string }> = {
  quick: { Icon: Zap, label: '快速会话' },
  collab: { Icon: Users, label: '协作会话' },
  task_execution: { Icon: ListTodo, label: '任务执行会话' },
};

/** 折叠持久化键：按工作空间隔离（JSON 数组 = 折叠中的组 id 集） */
const collapsedStorageKey = (workspaceId: string): string =>
  `momo.sessionGroups.collapsed.${workspaceId}`;

function writeCollapsedIds(workspaceId: string | null, ids: ReadonlySet<string>): void {
  if (!workspaceId) return;
  localStorage.setItem(collapsedStorageKey(workspaceId), JSON.stringify([...ids]));
}

function readCollapsed(workspaceId: string | null): Set<string> {
  if (!workspaceId) return new Set();
  try {
    const raw = localStorage.getItem(collapsedStorageKey(workspaceId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    // localStorage 不可用 / 存量值损坏：按无折叠处理
    return new Set();
  }
}

/** 错误 IPC message 归一（与 handleDissolve 的 alert 文案格式一致） */
function ipcErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// 批量拖影定值（drag-ghost-stack 预览批准）：克隆真实行卡层叠错落
const GHOST_WIDTH_PX = 204;
const GHOST_LAYER_OFFSET_PX = 6;
const GHOST_MAX_LAYERS = 3;

/**
 * 构造批量拖影节点：最多 3 层克隆的真实会话行卡（每层 +6px,+6px 错落、
 * 深层透明 0.8/0.6），N>3 时顶层右上 ×N 徽标。源行不在 DOM（如折叠组内）
 * 的层跳过。节点挂 body 外（setDragImage 栅格化后 dragEnd 移除）。
 */
function buildDragGhost(
  layerSessions: SessionSummary[],
  total: number,
  theme: GroupColorTheme,
): HTMLDivElement {
  const ghost = document.createElement('div');
  ghost.style.cssText = `position:fixed;top:-1000px;left:-1000px;width:${GHOST_WIDTH_PX}px;z-index:9999`;
  layerSessions.slice(-GHOST_MAX_LAYERS).forEach((s, i) => {
    const src = document.querySelector<HTMLElement>(`[data-session-id="${s.id}"]`);
    if (!src) return;
    const wrap = document.createElement('div');
    wrap.style.cssText =
      `position:absolute;left:${GHOST_LAYER_OFFSET_PX * i}px;top:${GHOST_LAYER_OFFSET_PX * i}px;` +
      `width:${GHOST_WIDTH_PX}px;height:36px;border-radius:6px;overflow:hidden;` +
      'background:rgb(var(--surface-1));border:1px solid rgb(var(--border-subtle));' +
      'box-shadow:0 4px 14px rgba(0,0,0,.18);' +
      (i > 0 ? `opacity:${i === 1 ? '0.8' : '0.6'};` : '');
    const clone = src.cloneNode(true) as HTMLElement;
    clone.style.cssText = 'width:100%;height:100%;';
    wrap.appendChild(clone);
    ghost.appendChild(wrap);
  });
  if (total > GHOST_MAX_LAYERS) {
    const badge = document.createElement('div');
    badge.textContent = `×${total}`;
    badge.style.cssText =
      'position:absolute;right:-9px;top:-9px;padding:2px 6px;border-radius:9px;' +
      'background:rgb(var(--border-focus));font:600 10px/-1 system-ui;' +
      `color:${theme === 'dark' ? 'rgb(var(--bg-canvas))' : '#fff'};` +
      'box-shadow:0 2px 6px rgba(0,0,0,.3);';
    ghost.appendChild(badge);
  }
  document.body.appendChild(ghost);
  return ghost;
}

// ─── 会话行 ───────────────────────────────────────────────────────────────────

interface SessionItemProps {
  session: SessionSummary;
  active: boolean;
  theme: GroupColorTheme;
  /** 是否展示组身份（圆点 + 组名后缀）——置顶区行与搜索拍平行为 true（组身份随行走） */
  showGroupBadge: boolean;
  /** 所属组色（查 groups 表；组不可见时 undefined → 不渲染圆点） */
  groupColor: string | undefined;
  /** 组内行（整体卡片内）水平边距 4px；独立行（置顶/未分组/搜索）6px（预览定值） */
  inGroupCard: boolean;
  /** 多选选中态（方案 A：surface-active 底 + 左 2px accent 竖条） */
  selected: boolean;
  /** 行点击（含修饰键）：RoomList 内判定 激活/范围选/追加 */
  onRowClick: (mods: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => void;
  /** 右键 → RoomList 开会话菜单（坐标取弹出点） */
  onContextMenu: (e: { clientX: number; clientY: number }) => void;
  onRowDragStart: (e: { dataTransfer: DataTransfer | null }) => void;
  onRowDragEnd: () => void;
}

/** 会话行（2026-10-22 右键菜单改造 · 预览批准定值）：36px 卡片行
 *  （h-9 · mx-1.5/my-0.5 · rounded-md），hover/active 整行圆角底色高亮；
 *  无 hover 工具条——全部操作走右键菜单；类型图标 14px + Pin 10px 徽标 +
 *  圆点 6px 保留（v2.2 图标极简约束）。多选改造：selected 态 + 可拖拽。 */
function SessionItem({
  session,
  active,
  theme,
  showGroupBadge,
  groupColor,
  inGroupCard,
  selected,
  onRowClick,
  onContextMenu,
  onRowDragStart,
  onRowDragEnd,
}: SessionItemProps) {
  const { Icon, label } = TYPE_ICON[deriveSessionType(session)];
  const pinned = session.pinnedAt != null;
  return (
    <div className={cn('my-0.5', inGroupCard ? 'mx-1' : 'mx-1.5')}>
      <button
        type="button"
        draggable
        onDragStart={onRowDragStart}
        onDragEnd={onRowDragEnd}
        data-session-id={session.id}
        data-selected={selected || undefined}
        onClick={(e) =>
          onRowClick({ shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey })
        }
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e);
        }}
        className={cn(
          'relative w-full h-9 rounded-md text-left px-2.5 text-[13px] transition-colors flex items-center gap-2',
          active
            ? 'bg-surface-active text-accent-600 dark:text-accent-300'
            : cn('text-secondary hover:bg-surface-3', selected && 'bg-surface-active'),
        )}
      >
        {selected && (
          <span
            data-testid="sel-bar"
            aria-hidden
            className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent-500"
          />
        )}
        <span
          role="img"
          aria-label={label}
          title={label}
          className="shrink-0 inline-flex text-tertiary"
        >
          <Icon size={14} strokeWidth={1.75} aria-hidden />
        </span>
        <span className="truncate flex-1">{session.title}</span>
        {showGroupBadge && session.groupName && (
          <span className="flex items-center gap-1 shrink-0">
            {groupColor != null && (
              <span
                data-testid="group-dot"
                aria-hidden
                className="h-1.5 w-1.5 rounded-full shrink-0"
                style={{ backgroundColor: groupDotColor(groupColor, theme) }}
              />
            )}
            <span className="text-xs text-tertiary">{session.groupName}</span>
          </span>
        )}
        {pinned && (
          <span
            role="img"
            aria-label="已置顶"
            title={session.groupName ? `已置顶（属于 ${session.groupName}）` : '已置顶'}
            className="shrink-0 inline-flex text-tertiary"
          >
            <Pin size={10} strokeWidth={1.75} aria-hidden />
          </span>
        )}
      </button>
    </div>
  );
}

// ─── 组头 + 色板面板 ──────────────────────────────────────────────────────────

interface GroupHeaderProps {
  group: SessionGroupRow;
  count: number;
  collapsed: boolean;
  theme: GroupColorTheme;
  /** 展开态组头在整体卡片内（tint 顶到卡片内缘，无独立边距/圆角）；折叠态为独立 tint 圆角条 */
  inCard: boolean;
  onToggleCollapsed: () => void;
  /** 右键 → RoomList 开组头菜单 */
  onContextMenu: (e: { clientX: number; clientY: number }) => void;
  /** 折叠态作拖拽放置目标（展开态目标为外层组卡） */
  dropHandlers?: {
    onDragOver: (e: ReactDragEvent<HTMLElement>) => void;
    onDragLeave: (e: ReactDragEvent<HTMLElement>) => void;
    onDrop: (e: ReactDragEvent<HTMLElement>) => void;
  };
  dropHot?: boolean;
}

/** 组头：tint 底色 + 折叠 chevron + 名称 + 计数；hover 操作钮已移除——操作走右键菜单 */
function GroupHeader({
  group,
  count,
  collapsed,
  theme,
  inCard,
  onToggleCollapsed,
  onContextMenu,
  dropHandlers,
  dropHot = false,
}: GroupHeaderProps) {
  return (
    <div
      data-testid="session-group-header"
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      onClick={onToggleCollapsed}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggleCollapsed();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e);
      }}
      {...(dropHandlers ?? {})}
      className={cn(
        'flex items-center gap-1.5 h-7 px-2.5 cursor-pointer select-none',
        !inCard && 'mx-1.5 my-0.5 rounded-md',
      )}
      style={{
        backgroundColor: groupTintColor(group.color, theme),
        ...(dropHot
          ? { outline: `2px solid ${groupDotColor(group.color, theme)}`, outlineOffset: '-2px' }
          : {}),
      }}
    >
      {collapsed ? (
        <ChevronRight size={12} strokeWidth={1.75} className="text-tertiary shrink-0" aria-hidden />
      ) : (
        <ChevronDown size={12} strokeWidth={1.75} className="text-tertiary shrink-0" aria-hidden />
      )}
      <span className="text-xs font-medium text-secondary truncate">{group.name}</span>
      <span className="text-xs text-tertiary shrink-0">({count})</span>
    </div>
  );
}

// ─── RoomList 主体 ────────────────────────────────────────────────────────────

export function RoomList() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  const loadSessions = useSessionStore((s) => s.loadSessions);
  const refreshSessionList = useSessionStore((s) => s.refreshSessionList);
  const loading = useSessionStore((s) => s.loading);
  const createQuickSession = useSessionStore((s) => s.createQuickSession);
  const setPendingCreateGroupId = useSessionStore((s) => s.setPendingCreateGroupId);
  const revealSessionId = useSessionStore((s) => s.revealSessionId);
  const setRevealSessionId = useSessionStore((s) => s.setRevealSessionId);
  const workspace = useWorkspaceStore((s) => s.getActive());
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const theme = useThemeStore((s) => s.resolved);

  const [renaming, setRenaming] = useState<{ sessionId: string; oldTitle: string } | null>(null);
  // 等待 ConfirmDialog 二次确认的解散目标（null = 对话框未开）
  const [dissolving, setDissolving] = useState<{ sessionId: string; title: string } | null>(null);

  // 标题搜索过滤（spec §3）：瞬态本地态；空输入 = 不过滤
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const visibleSessions =
    q === '' ? sessions : sessions.filter((s) => s.title.toLowerCase().includes(q));

  // 分组 / 折叠 / 弹窗态（Task 7）
  const [groups, setGroups] = useState<SessionGroupRow[]>([]);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState<SessionSummary[] | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [renamingGroup, setRenamingGroup] = useState<SessionGroupRow | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<{ group: SessionGroupRow; count: number } | null>(
    null,
  );
  // 换色浮层态（取代旧 paletteFor 行内色板）：目标组 + 弹出坐标
  const [colorPopover, setColorPopover] = useState<{
    group: SessionGroupRow;
    x: number;
    y: number;
  } | null>(null);
  // 分组菜单建会（建后归组）：pending 目标写 store；无默认 agent 先弹 Picker
  const [quickPickerOpen, setQuickPickerOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);

  const handleGroupQuickCreate = (group: SessionGroupRow): void => {
    setPendingCreateGroupId(group.id);
    if (workspace?.defaultAgentInstanceId) {
      void createQuickSession(workspace.id);
    } else {
      setQuickPickerOpen(true);
    }
  };

  const handleGroupCollabCreate = (group: SessionGroupRow): void => {
    setPendingCreateGroupId(group.id);
    setCollabOpen(true);
            useUiStore.getState().setPendingCollabDraft(null); // D9：手动入口弃在途草稿;
  };
  // 右键菜单态：会话行/组头两类目标 + 弹出坐标（动作复用既有 handler）
  const [menu, setMenu] = useState<
    | { kind: 'session'; session: SessionSummary; x: number; y: number }
    | { kind: 'group'; group: SessionGroupRow; x: number; y: number }
    | { kind: 'batch'; sessions: SessionSummary[]; x: number; y: number }
    | null
  >(null);
  // 多选（2026-10-22 多选+拖拽改造）：selectedIds + 范围选锚点；瞬态不落库
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [dissolvingBatch, setDissolvingBatch] = useState<SessionSummary[] | null>(null);
  // DnD：拖拽中标记（控制移出条浮现/目标高亮）+ 当前拖拽 id 集（drop 可靠源）
  const [dragging, setDragging] = useState(false);
  const [draggingIds, setDraggingIds] = useState<string[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);

  const clearSelection = useCallback((): void => {
    setSelectedIds(new Set());
    setAnchorId(null);
  }, []);

  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const loadGroups = useCallback(async (workspaceId: string | null): Promise<void> => {
    if (!workspaceId) return;
    try {
      setGroups(await ipc.sessionGroup.list(workspaceId));
    } catch {
      // 拉组失败降级：全部会话按未分组平铺渲染（有回归锁），不阻塞列表
      setGroups([]);
    } finally {
      setGroupsLoaded(true);
    }
  }, []);

  useEffect(() => {
    // 切 workspace：重拉分组 + 恢复该工作空间的折叠态；过滤与多选清空（spec §6）
    setFilter('');
    clearSelection();
    setGroupsLoaded(false);
    setCollapsedIds(readCollapsed(activeWorkspaceId));
    void loadGroups(activeWorkspaceId);
  }, [activeWorkspaceId, loadGroups, clearSelection]);

  useEffect(() => {
    // 切换 workspace 时按当前 workspace 过滤会话；workspace 尚未就绪时
    // store 守卫拦截无参拉取（绝不跨仓——主进程无参走 listAllSessions 全仓）
    void loadSessions(activeWorkspaceId ?? undefined);
  }, [loadSessions, activeWorkspaceId]);

  const toggleCollapsed = (groupId: string): void => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      if (activeWorkspaceId) {
        try {
          localStorage.setItem(collapsedStorageKey(activeWorkspaceId), JSON.stringify([...next]));
        } catch {
          // localStorage 不可用：会话内折叠仍生效，仅不持久化
        }
      }
      return next;
    });
  };

  const submitRename = async (name: string) => {
    const target = renaming;
    setRenaming(null);
    if (target && name.trim() && name !== target.oldTitle) {
      await ipc.session.rename(target.sessionId, name.trim());
      refreshSessionList();
    }
  };

  /** ConfirmDialog 确认后的实际解散：删会话 + 刷新列表；失败 alert（语义与替换前一致） */
  const handleDissolve = async (sessionId: string) => {
    try {
      await ipc.session.delete(sessionId);
      refreshSessionList();
    } catch (err) {
      alert(`解散失败：${ipcErrorMessage(err)}`);
    }
  };

  const handleTogglePin = (session: SessionSummary): void => {
    void ipc.session
      .setPinned(session.id, session.pinnedAt == null)
      .then(() => refreshSessionList())
      .catch((err: unknown) => alert(`置顶失败：${ipcErrorMessage(err)}`));
  };

  const submitCreateGroup = (name: string): void => {
    setCreatingGroup(false);
    const trimmed = name.trim();
    if (!trimmed || !activeWorkspaceId) return;
    void ipc.sessionGroup
      .create(activeWorkspaceId, trimmed)
      .then(() => loadGroups(activeWorkspaceId))
      .catch((err: unknown) => alert(`新建分组失败：${ipcErrorMessage(err)}`));
  };

  const submitRenameGroup = (name: string): void => {
    const target = renamingGroup;
    setRenamingGroup(null);
    const trimmed = name.trim();
    if (!target || !trimmed || trimmed === target.name) return;
    void ipc.sessionGroup
      .rename(target.id, trimmed)
      .then(() => {
        void loadGroups(activeWorkspaceId);
        // 组名后缀数据源在会话行（groupName）：双刷新
        refreshSessionList();
      })
      .catch((err: unknown) => alert(`重命名分组失败：${ipcErrorMessage(err)}`));
  };

  const handleDeleteGroup = async (groupId: string): Promise<void> => {
    try {
      await ipc.sessionGroup.delete(groupId);
      await loadGroups(activeWorkspaceId);
      refreshSessionList();
    } catch (err) {
      alert(`删除分组失败：${ipcErrorMessage(err)}`);
    }
  };

  const applyGroupColor = (groupId: string, color: string): void => {
    void ipc.sessionGroup
      .setColor(groupId, color)
      .then(() => loadGroups(activeWorkspaceId))
      .catch((err: unknown) => alert(`设置组色失败：${ipcErrorMessage(err)}`));
  };

  // 定位会话信号消费：目标组折叠 → 先展开（持久化，行渲染后下轮再滚）；
  // 行在 DOM → scrollIntoView 居中 + 清信号；目标不在列表（已删/过滤未命中）→ 清信号防悬挂。
  // groupsLoaded 门控：组列表未就绪时 groupId 折叠判定不可靠（会话被临时按未分组
  // 渲染，提前消费会漏展开——挂载竞态回归锁在 test）；revealedRef 去重防无关
  // 状态扰动触发二次滚动（mock store 不回写时同样成立）
  const revealedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!revealSessionId) {
      revealedRef.current = null;
      return;
    }
    if (revealedRef.current === revealSessionId) return;
    const target = sessions.find((s) => s.id === revealSessionId);
    if (!target) {
      setRevealSessionId(null);
      revealedRef.current = revealSessionId;
      return;
    }
    if (!groupsLoaded && target.groupId != null) return;
    if (target.groupId != null && collapsedIds.has(target.groupId)) {
      // 展开轮不记 ref：下一轮（行已渲染）继续执行滚动终态
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        next.delete(target.groupId!);
        writeCollapsedIds(activeWorkspaceId, next);
        return next;
      });
      return;
    }
    const el = document.querySelector(`[data-session-id="${revealSessionId}"]`);
    if (el) el.scrollIntoView({ block: 'center' });
    setRevealSessionId(null);
    revealedRef.current = revealSessionId;
  }, [revealSessionId, sessions, collapsedIds, groupsLoaded, activeWorkspaceId, setRevealSessionId]);

  // Escape 清空多选（菜单开着时让位给菜单自身的 Escape）
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && menu == null) clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds.size, menu, clearSelection]);

  /** 批量解散：逐个 delete，首个失败 alert 并中断；收尾刷新 + 清选择 */
  const handleBatchDissolve = async (): Promise<void> => {
    const batch = dissolvingBatch;
    setDissolvingBatch(null);
    if (!batch) return;
    for (const s of batch) {
      try {
        await ipc.session.delete(s.id);
      } catch (err) {
        alert(`解散失败：${ipcErrorMessage(err)}`);
        break;
      }
    }
    refreshSessionList();
    clearSelection();
  };

  const handleRowDragStart = (session: SessionSummary, e: { dataTransfer: DataTransfer | null }): void => {
    // 拖选中行=拖整批；拖非选中行=只拖该行（选择重置）
    const ids = selectedIds.has(session.id) ? [...selectedIds] : [session.id];
    if (!selectedIds.has(session.id)) clearSelection();
    setDraggingIds(ids);
    setDragging(true);
    const dt = e.dataTransfer;
    if (dt) {
      try {
        dt.setData('text/plain', JSON.stringify(ids));
        dt.effectAllowed = 'move';
        if (ids.length > 1) {
          dragGhostRef.current = buildDragGhost(
            sessions.filter((s) => selectedIds.has(s.id) || s.id === session.id),
            ids.length,
            theme,
          );
          dt.setDragImage(dragGhostRef.current, 100, 18);
        }
      } catch {
        // dataTransfer 不可用（异常环境）：拖拽降级——内部状态仍可完成 drop
      }
    }
  };

  const handleRowDragEnd = (): void => {
    setDragging(false);
    setDraggingIds([]);
    setDropTarget(null);
    if (dragGhostRef.current) {
      dragGhostRef.current.remove();
      dragGhostRef.current = null;
    }
  };

  /** drop 统一入口：目标组 id（null=移出分组）；draggingIds 优先，dataTransfer 兜底 */
  const handleDrop = async (
    e: { preventDefault: () => void; dataTransfer: DataTransfer | null },
    targetGroupId: string | null,
  ): Promise<void> => {
    e.preventDefault();
    let ids = draggingIds;
    if (ids.length === 0) {
      const raw = e.dataTransfer?.getData('text/plain') ?? '';
      try {
        const parsed: unknown = JSON.parse(raw);
        ids = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        ids = [];
      }
    }
    handleRowDragEnd();
    for (const id of ids) {
      try {
        await ipc.session.moveToGroup(id, targetGroupId);
      } catch (err) {
        alert(`移动失败：${ipcErrorMessage(err)}`);
        break;
      }
    }
    refreshSessionList();
    clearSelection();
  };

  const dropHandlers = (key: string, targetGroupId: string | null) => ({
    onDragOver: (e: ReactDragEvent<HTMLElement>): void => {
      e.preventDefault();
      setDropTarget(key);
    },
    onDragLeave: (e: ReactDragEvent<HTMLElement>): void => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
    },
    onDrop: (e: ReactDragEvent<HTMLElement>): void => {
      void handleDrop(e, targetGroupId);
    },
  });

  if (loading && sessions.length === 0) {
    return (
      <div className="w-full flex-1 min-h-0 bg-surface-1 flex items-center justify-center">
        <p className="text-sm text-tertiary">加载中…</p>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="w-full flex-1 min-h-0 bg-surface-1 flex items-center justify-center">
        <EmptyState
          icon={MessageSquare}
          title="暂无会话"
          description="用上方「快速会话」或「协作会话」按钮开始对话"
          action={
            <button
              type="button"
              onClick={() => void loadSessions()}
              className="text-xs text-accent-600 dark:text-accent-300 hover:underline mt-1"
            >
              刷新
            </button>
          }
        />
      </div>
    );
  }

  // 非过滤态分桶（sessions 已是主进程全局序；组序 = groups position，空组也渲染组头）
  const pinned = visibleSessions.filter((s) => s.pinnedAt != null);
  const unpinned = visibleSessions.filter((s) => s.pinnedAt == null);
  const byGroup = new Map<string, SessionSummary[]>();
  for (const g of groups) byGroup.set(g.id, []);
  const ungrouped: SessionSummary[] = [];
  for (const s of unpinned) {
    if (s.groupId && byGroup.has(s.groupId)) byGroup.get(s.groupId)!.push(s);
    else ungrouped.push(s);
  }
  const colorByGroupId = new Map(groups.map((g) => [g.id, g.color] as const));

  // 多选范围序：非过滤态 = 置顶区 → 各组（组序）→ 未分组（DOM 顺序）；过滤态 = 拍平序
  const flatOrder =
    q === ''
      ? [...pinned, ...groups.flatMap((g) => byGroup.get(g.id) ?? []), ...ungrouped].map((s) => s.id)
      : visibleSessions.map((s) => s.id);

  const handleRowClick = (
    session: SessionSummary,
    mods: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  ): void => {
    if (mods.shiftKey) {
      const indexById = new Map(flatOrder.map((id, i) => [id, i] as const));
      const targetIdx = indexById.get(session.id);
      if (targetIdx == null) return;
      const anchorIdx = anchorId != null ? indexById.get(anchorId) : undefined;
      const from = anchorIdx ?? targetIdx;
      const [lo, hi] = from <= targetIdx ? [from, targetIdx] : [targetIdx, from];
      setSelectedIds(new Set(flatOrder.slice(lo, hi + 1)));
      if (anchorIdx == null) setAnchorId(session.id);
      return;
    }
    if (mods.metaKey || mods.ctrlKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(session.id)) next.delete(session.id);
        else next.add(session.id);
        return next;
      });
      setAnchorId(session.id);
      return;
    }
    clearSelection();
    // 普通点击同时立锚点（后续 Shift 范围选的起点）
    setAnchorId(session.id);
    void selectSession(session.id);
  };

  const renderSessionItem = (session: SessionSummary, showGroupBadge: boolean, inGroupCard = false) => (
    <SessionItem
      key={session.id}
      session={session}
      active={session.id === activeSessionId}
      theme={theme}
      showGroupBadge={showGroupBadge}
      groupColor={session.groupId != null ? colorByGroupId.get(session.groupId) : undefined}
      inGroupCard={inGroupCard}
      selected={selectedIds.has(session.id)}
      onRowClick={(mods) => handleRowClick(session, mods)}
      onContextMenu={(e) => {
        // 集内>1 → 批量菜单；集外 → 清空选择开单行菜单（桌面惯例）
        if (selectedIds.has(session.id) && selectedIds.size > 1) {
          setMenu({
            kind: 'batch',
            sessions: sessions.filter((s) => selectedIds.has(s.id)),
            x: e.clientX,
            y: e.clientY,
          });
          return;
        }
        if (selectedIds.size > 0) clearSelection();
        setMenu({ kind: 'session', session, x: e.clientX, y: e.clientY });
      }}
      onRowDragStart={(e) => handleRowDragStart(session, e)}
      onRowDragEnd={handleRowDragEnd}
    />
  );

  return (
    <div className="w-full flex-1 min-h-0 bg-surface-1 flex flex-col">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-subtle shrink-0">
        <Search size={14} strokeWidth={1.75} className="text-tertiary shrink-0" aria-hidden />
        <input
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            clearSelection();
          }}
          placeholder="搜索会话"
          aria-label="搜索会话"
          className="flex-1 min-w-0 bg-transparent text-sm text-primary placeholder:text-tertiary outline-none"
        />
        {filter !== '' && (
          <button
            type="button"
            aria-label="清除搜索"
            title="清除搜索"
            onClick={() => setFilter('')}
            className="text-tertiary hover:text-primary shrink-0"
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        )}
        <button
          type="button"
          aria-label="定位当前会话"
          title="定位当前会话：滚动到当前会话并展开所在分组"
          disabled={activeSessionId == null}
          onClick={() => {
            if (activeSessionId != null) setRevealSessionId(activeSessionId);
          }}
          className={cn(
            'text-tertiary hover:text-primary shrink-0',
            activeSessionId == null && 'opacity-40 cursor-not-allowed',
          )}
        >
          <Crosshair size={14} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="新建分组"
          title="新建分组"
          onClick={() => setCreatingGroup(true)}
          className="text-tertiary hover:text-primary shrink-0"
        >
          <FolderPlus size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      {visibleSessions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-tertiary">
          无匹配会话
        </div>
      ) : q !== '' ? (
        // 搜索拍平态：无组头无置顶区结构，平铺保留类型图标 + Pin + 圆点 + 组名后缀
        <div
          className="flex-1 overflow-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget) clearSelection();
          }}
        >
          {visibleSessions.map((session) => renderSessionItem(session, true))}
        </div>
      ) : (
        <div
          className="flex-1 overflow-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget) clearSelection();
          }}
        >
          {pinned.map((session) => renderSessionItem(session, true))}
          {groups.map((group) => {
            const items = byGroup.get(group.id) ?? [];
            const collapsed = collapsedIds.has(group.id);
            const openGroupMenu = (e: { clientX: number; clientY: number }): void =>
              setMenu({ kind: 'group', group, x: e.clientX, y: e.clientY });
            if (collapsed) {
              // 折叠态：组头为独立 tint 圆角条（无边框包裹——无内容可包），兼作拖拽放置目标
              return (
                <GroupHeader
                  key={group.id}
                  group={group}
                  count={items.length}
                  collapsed={collapsed}
                  theme={theme}
                  inCard={false}
                  onToggleCollapsed={() => toggleCollapsed(group.id)}
                  onContextMenu={openGroupMenu}
                  dropHandlers={dropHandlers(`group:${group.id}`, group.id)}
                  dropHot={dropTarget === `group:${group.id}`}
                />
              );
            }            // 展开态（预览批准定值）：组头 + 组内会话包在同一组色 1px 边框整体卡片
            // （rounded-lg 单圆角 · overflow-hidden 让 tint 顶到卡片内缘）
            return (
              <div
                key={group.id}
                data-testid="session-group-card"
                {...dropHandlers(`group:${group.id}`, group.id)}
                className="mx-1.5 my-0.5 rounded-lg border overflow-hidden"
                style={{
                  borderColor: groupBorderColor(group.color, theme),
                  ...(dropTarget === `group:${group.id}`
                    ? {
                        outline: `2px solid ${groupDotColor(group.color, theme)}`,
                        outlineOffset: '-2px',
                      }
                    : {}),
                }}
              >
                <GroupHeader
                  group={group}
                  count={items.length}
                  collapsed={collapsed}
                  theme={theme}
                  inCard={true}
                  onToggleCollapsed={() => toggleCollapsed(group.id)}
                  onContextMenu={openGroupMenu}
                />
                {items.map((session) => renderSessionItem(session, false, true))}
              </div>
            );
          })}
          {ungrouped.map((session) => renderSessionItem(session, false))}
          {/* 移出分组放置条：仅拖拽期间浮现（防误放，预览批准定值） */}
          {dragging && q === '' && (
            <div
              data-testid="ungroup-drop-zone"
              {...dropHandlers('ungroup', null)}
              className={cn(
                'flex items-center justify-center h-9 mx-1.5 mt-1.5 rounded-md border-[1.5px] border-dashed text-xs select-none',
                dropTarget === 'ungroup'
                  ? 'border-focus border-solid bg-surface-active text-accent-600 dark:text-accent-300'
                  : 'border-strong text-tertiary',
              )}
            >
              拖到此处移出分组
            </div>
          )}
        </div>
      )}
      {renaming && (
        <PromptDialog
          title="重命名会话"
          defaultValue={renaming.oldTitle}
          onSubmit={submitRename}
          onClose={() => setRenaming(null)}
        />
      )}
      {dissolving && (
        <ConfirmDialog
          title="解散会话"
          message={`确定解散会话「${dissolving.title}」？\n所有成员将被移除。`}
          confirmLabel="解散"
          onConfirm={() => void handleDissolve(dissolving.sessionId)}
          onClose={() => setDissolving(null)}
        />
      )}
      {moving && activeWorkspaceId != null && (
        <MoveToGroupDialog
          sessions={moving}
          workspaceId={activeWorkspaceId}
          onClose={() => {
            setMoving(null);
            // 内联建组路径会变更组集合：不重拉则新组头不出现、被移会话落孤儿
            // 路径渲染进未分组（移动到既有组/移出分组多一次 list 调用无害）
            void loadGroups(activeWorkspaceId);
          }}
        />
      )}
      {creatingGroup && (
        <PromptDialog
          title="新建分组"
          label="分组名"
          placeholder="分组名"
          onSubmit={submitCreateGroup}
          onClose={() => setCreatingGroup(false)}
        />
      )}
      {renamingGroup && (
        <PromptDialog
          title="重命名分组"
          defaultValue={renamingGroup.name}
          onSubmit={submitRenameGroup}
          onClose={() => setRenamingGroup(null)}
        />
      )}
      {deletingGroup && (
        <ConfirmDialog
          title="删除分组"
          message={`只删除分组，组内 ${deletingGroup.count} 个会话将回到未分组`}
          confirmLabel="删除"
          onConfirm={() => void handleDeleteGroup(deletingGroup.group.id)}
          onClose={() => setDeletingGroup(null)}
        />
      )}
      {menu?.kind === 'session' && (
        <SessionContextMenu
          x={menu.x}
          y={menu.y}
          pinned={menu.session.pinnedAt != null}
          onTogglePin={() => handleTogglePin(menu.session)}
          onMove={() => setMoving([menu.session])}
          onRename={() => setRenaming({ sessionId: menu.session.id, oldTitle: menu.session.title })}
          onDissolve={() => setDissolving({ sessionId: menu.session.id, title: menu.session.title })}
          onClose={() => setMenu(null)}
        />
      )}
      {menu?.kind === 'group' && (
        <GroupContextMenu
          x={menu.x}
          y={menu.y}
          onQuickCreate={() => handleGroupQuickCreate(menu.group)}
          onCollabCreate={() => handleGroupCollabCreate(menu.group)}
          onPalette={() => setColorPopover({ group: menu.group, x: menu.x, y: menu.y })}
          onRename={() => setRenamingGroup(menu.group)}
          onDelete={() =>
            setDeletingGroup({
              group: menu.group,
              count: byGroup.get(menu.group.id)?.length ?? 0,
            })
          }
          onClose={() => setMenu(null)}
        />
      )}
      {menu?.kind === 'batch' && (
        <BatchSessionContextMenu
          x={menu.x}
          y={menu.y}
          count={menu.sessions.length}
          onMove={() => setMoving(menu.sessions)}
          onDissolve={() => setDissolvingBatch(menu.sessions)}
          onClose={() => setMenu(null)}
        />
      )}
      {dissolvingBatch && (
        <ConfirmDialog
          title="解散会话"
          message={`确定解散 ${dissolvingBatch.length} 个会话？\n所有成员将被移除。`}
          confirmLabel="解散"
          onConfirm={() => void handleBatchDissolve()}
          onClose={() => setDissolvingBatch(null)}
        />
      )}
      {colorPopover && (
        <SessionGroupColorPopover
          x={colorPopover.x}
          y={colorPopover.y}
          group={colorPopover.group}
          theme={theme}
          onPick={(color) => applyGroupColor(colorPopover.group.id, color)}
          onClose={() => setColorPopover(null)}
        />
      )}
      {quickPickerOpen && workspace && (
        <DefaultAgentPickerDialog
          workspaceId={workspace.id}
          onContinue={() => {
            setQuickPickerOpen(false);
            void createQuickSession(workspace.id);
          }}
          onClose={() => {
            setQuickPickerOpen(false);
            setPendingCreateGroupId(null);
          }}
        />
      )}
      {collabOpen && (
        <CollabSessionDialog
          onClose={() => {
            setCollabOpen(false);
            setPendingCreateGroupId(null);
          }}
        />
      )}
    </div>
  );
}
