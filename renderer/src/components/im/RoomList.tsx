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
import { useCallback, useEffect, useState } from 'react';
import { useSessionStore } from '../../stores/session.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useThemeStore } from '../../stores/theme.store';
import { ipc } from '../../ipc/client';
import { PromptDialog } from '../common/PromptDialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { cn } from '../../lib/cn';
import { deriveSessionType, type SessionType } from '../../lib/session-type';
import {
  GROUP_COLOR_PALETTE,
  groupDotColor,
  groupTintColor,
  type GroupColorTheme,
} from '../../lib/group-colors';
import { MoveToGroupDialog } from './MoveToGroupDialog';
import type { SessionGroupRow, SessionSummary } from '../../ipc/types';
import {
  Ban,
  ChevronDown,
  ChevronRight,
  FolderInput,
  FolderPlus,
  ListTodo,
  MessageSquare,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
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

// ─── 会话行 ───────────────────────────────────────────────────────────────────

interface SessionItemProps {
  session: SessionSummary;
  active: boolean;
  theme: GroupColorTheme;
  /** 是否展示组身份（圆点 + 组名后缀）——置顶区行与搜索拍平行为 true（组身份随行走） */
  showGroupBadge: boolean;
  /** 所属组色（查 groups 表；组不可见时 undefined → 不渲染圆点） */
  groupColor: string | undefined;
  onSelect: () => void;
  onTogglePin: () => void;
  onMove: () => void;
  onRename: () => void;
  onDissolve: () => void;
}

/** 会话行：28px 紧凑密度 + 类型图标 14px + 工具条钮 12px + Pin 10px + 圆点 6px（预览 A 定值） */
function SessionItem({
  session,
  active,
  theme,
  showGroupBadge,
  groupColor,
  onSelect,
  onTogglePin,
  onMove,
  onRename,
  onDissolve,
}: SessionItemProps) {
  const { Icon, label } = TYPE_ICON[deriveSessionType(session)];
  const pinned = session.pinnedAt != null;
  return (
    <div className="group/row relative">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'w-full h-7 text-left pl-3 pr-2 text-sm transition-colors border-l-2 flex items-center gap-2',
          active
            ? 'bg-surface-active border-transparent text-accent-600 dark:text-accent-300'
            : 'border-transparent text-secondary hover:bg-surface-3',
          // 置顶行右侧让位恒显 Pin：8 + 10 + 8 = 26px（预览 A 定值）
          pinned && 'pr-[26px]',
        )}
      >
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
      {/* hover 工具条：四裸钮无独立底色（继承行 hover 底色）；置顶行左移让位恒显 Pin */}
      <span
        className={cn(
          'absolute top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 transition-opacity group-hover/row:opacity-100',
          pinned ? 'right-[26px]' : 'right-2',
        )}
      >
        <button
          type="button"
          title={pinned ? '取消置顶' : '置顶'}
          aria-label={pinned ? '取消置顶' : '置顶'}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          className="text-tertiary hover:text-primary"
        >
          {pinned ? (
            <PinOff size={12} strokeWidth={1.75} aria-hidden />
          ) : (
            <Pin size={12} strokeWidth={1.75} aria-hidden />
          )}
        </button>
        <button
          type="button"
          title="移动到分组"
          aria-label="移动到分组"
          onClick={(e) => {
            e.stopPropagation();
            onMove();
          }}
          className="text-tertiary hover:text-primary"
        >
          <FolderInput size={12} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          title="重命名"
          aria-label="重命名"
          onClick={(e) => {
            e.stopPropagation();
            onRename();
          }}
          className="text-tertiary hover:text-primary"
        >
          <Pencil size={12} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          title="解散"
          aria-label="解散"
          onClick={(e) => {
            e.stopPropagation();
            onDissolve();
          }}
          className="text-tertiary hover:text-status-error"
        >
          <Trash2 size={12} strokeWidth={1.75} aria-hidden />
        </button>
      </span>
    </div>
  );
}

// ─── 组头 + 色板面板 ──────────────────────────────────────────────────────────

interface GroupHeaderProps {
  group: SessionGroupRow;
  count: number;
  collapsed: boolean;
  theme: GroupColorTheme;
  onToggleCollapsed: () => void;
  onPalette: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/** 组头：整行组色 tint（hover 不加深，仅浮现操作钮）+ 折叠 chevron + 名称 + 计数 */
function GroupHeader({
  group,
  count,
  collapsed,
  theme,
  onToggleCollapsed,
  onPalette,
  onRename,
  onDelete,
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
      className="group/hdr relative flex items-center gap-1.5 h-7 px-3 cursor-pointer select-none"
      style={{ backgroundColor: groupTintColor(group.color, theme) }}
    >
      {collapsed ? (
        <ChevronRight size={12} strokeWidth={1.75} className="text-tertiary shrink-0" aria-hidden />
      ) : (
        <ChevronDown size={12} strokeWidth={1.75} className="text-tertiary shrink-0" aria-hidden />
      )}
      <span className="text-xs font-medium text-secondary truncate">{group.name}</span>
      <span className="text-xs text-tertiary shrink-0">({count})</span>
      {/* 操作条：Palette·Pencil·Trash2 裸钮，直接落在 tint 上（无独立底色） */}
      <span className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 transition-opacity group-hover/hdr:opacity-100">
        <button
          type="button"
          title="设置组色"
          aria-label="设置组色"
          onClick={(e) => {
            e.stopPropagation();
            onPalette();
          }}
          className="text-tertiary hover:text-primary"
        >
          <Palette size={12} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          title="重命名分组"
          aria-label="重命名分组"
          onClick={(e) => {
            e.stopPropagation();
            onRename();
          }}
          className="text-tertiary hover:text-primary"
        >
          <Pencil size={12} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          title="删除分组"
          aria-label="删除分组"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="text-tertiary hover:text-status-error"
        >
          <Trash2 size={12} strokeWidth={1.75} aria-hidden />
        </button>
      </span>
    </div>
  );
}

interface GroupPaletteProps {
  group: SessionGroupRow;
  /** 组在列表中的序（恢复默认 = 色板[序 % 6]） */
  index: number;
  theme: GroupColorTheme;
  onPick: (color: string) => void;
}

/** Palette 面板（原地展开，预览 A 定值）：6 swatch + 恢复默认 + ＋自定义——面板内零文字 */
function GroupPalette({ group, index, theme, onPick }: GroupPaletteProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customHex, setCustomHex] = useState('');

  const submitCustom = (): void => {
    // trim 后才发（regex $ 可匹配尾换行——不能依赖后端校验堵空白）
    const v = customHex.trim();
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
      onPick(v);
      setCustomOpen(false);
      setCustomHex('');
    }
    // 非法值不发送（面板零文字约束：无错误文案位；格式提示走 title）
  };

  return (
    <div
      data-testid="group-palette"
      className="flex items-center gap-1.5 h-7 px-3"
      style={{ backgroundColor: groupTintColor(group.color, theme) }}
    >
      {GROUP_COLOR_PALETTE.map((hex, i) => (
        <button
          key={hex}
          type="button"
          aria-label={`色板 ${i + 1}`}
          title={`色板 ${i + 1}`}
          onClick={() => onPick(hex)}
          className="h-3.5 w-3.5 rounded-full border border-strong shrink-0 transition-transform hover:scale-110"
          style={{ backgroundColor: groupDotColor(hex, theme) }}
        />
      ))}
      <button
        type="button"
        aria-label="恢复默认色"
        title="恢复默认色"
        onClick={() => onPick(GROUP_COLOR_PALETTE[index % GROUP_COLOR_PALETTE.length] ?? '#5E6AD2')}
        className="text-tertiary hover:text-primary shrink-0"
      >
        <Ban size={12} strokeWidth={1.75} aria-hidden />
      </button>
      {customOpen ? (
        <input
          aria-label="自定义颜色"
          title="自定义颜色（#RRGGBB）"
          value={customHex}
          onChange={(e) => setCustomHex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitCustom();
            if (e.key === 'Escape') {
              setCustomOpen(false);
              setCustomHex('');
            }
          }}
          autoFocus
          className="w-16 h-5 rounded border border-subtle bg-surface-1 px-1 text-[11px] uppercase text-primary outline-none focus:border-focus"
        />
      ) : (
        <button
          type="button"
          aria-label="自定义颜色"
          title="自定义颜色"
          onClick={() => setCustomOpen(true)}
          className="h-3.5 w-3.5 rounded-full border border-dashed border-strong text-tertiary shrink-0 inline-flex items-center justify-center hover:text-primary"
        >
          <Plus size={10} strokeWidth={1.75} aria-hidden />
        </button>
      )}
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
  const [moving, setMoving] = useState<SessionSummary | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [renamingGroup, setRenamingGroup] = useState<SessionGroupRow | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<{ group: SessionGroupRow; count: number } | null>(
    null,
  );
  const [paletteFor, setPaletteFor] = useState<string | null>(null);

  const loadGroups = useCallback(async (workspaceId: string | null): Promise<void> => {
    if (!workspaceId) return;
    try {
      setGroups(await ipc.sessionGroup.list(workspaceId));
    } catch {
      // 拉组失败降级：全部会话按未分组平铺渲染（有回归锁），不阻塞列表
      setGroups([]);
    }
  }, []);

  useEffect(() => {
    // 切 workspace：重拉分组 + 恢复该工作空间的折叠态；过滤清空（spec §6）
    setFilter('');
    setCollapsedIds(readCollapsed(activeWorkspaceId));
    void loadGroups(activeWorkspaceId);
  }, [activeWorkspaceId, loadGroups]);

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

  const renderSessionItem = (session: SessionSummary, showGroupBadge: boolean) => (
    <SessionItem
      key={session.id}
      session={session}
      active={session.id === activeSessionId}
      theme={theme}
      showGroupBadge={showGroupBadge}
      groupColor={session.groupId != null ? colorByGroupId.get(session.groupId) : undefined}
      onSelect={() => void selectSession(session.id)}
      onTogglePin={() => handleTogglePin(session)}
      onMove={() => setMoving(session)}
      onRename={() => setRenaming({ sessionId: session.id, oldTitle: session.title })}
      onDissolve={() => setDissolving({ sessionId: session.id, title: session.title })}
    />
  );

  return (
    <div className="w-full flex-1 min-h-0 bg-surface-1 flex flex-col">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-subtle shrink-0">
        <Search size={14} strokeWidth={1.75} className="text-tertiary shrink-0" aria-hidden />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
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
        <div className="flex-1 overflow-auto">
          {visibleSessions.map((session) => renderSessionItem(session, true))}
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          {pinned.map((session) => renderSessionItem(session, true))}
          {groups.map((group, index) => {
            const items = byGroup.get(group.id) ?? [];
            const collapsed = collapsedIds.has(group.id);
            return (
              <div key={group.id}>
                <GroupHeader
                  group={group}
                  count={items.length}
                  collapsed={collapsed}
                  theme={theme}
                  onToggleCollapsed={() => toggleCollapsed(group.id)}
                  onPalette={() => setPaletteFor(paletteFor === group.id ? null : group.id)}
                  onRename={() => setRenamingGroup(group)}
                  onDelete={() => setDeletingGroup({ group, count: items.length })}
                />
                {paletteFor === group.id && (
                  <GroupPalette
                    group={group}
                    index={index}
                    theme={theme}
                    onPick={(color) => applyGroupColor(group.id, color)}
                  />
                )}
                {!collapsed && items.map((session) => renderSessionItem(session, false))}
              </div>
            );
          })}
          {ungrouped.map((session) => renderSessionItem(session, false))}
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
          session={moving}
          workspaceId={activeWorkspaceId}
          onClose={() => setMoving(null)}
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
    </div>
  );
}
