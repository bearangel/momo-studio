// renderer/src/components/layout/WorkspaceTabs.tsx
//
// TitleBar 内的 workspace tab 条（P2 Task 2）：每个 workspace 一个 tab
// （图标 + 名称 + hover 关闭 lucide X），激活 tab 高亮 + 底部 accent 条；
// lucide Plus 打开新建对话框；tab 右键弹自绘轻量浮层菜单，Esc / 点击菜单
// 外部关闭。整个 tab 条是交互区，整体标 no-drag。
//
// D6 走查修复（关标签 ≠ 删除）：X 与菜单「关闭标签」只把 tab 加入
// store.closedIds（会话级，重启后恢复全部标签），绝不触发删除；毁灭性删除
// 收敛到右键菜单「删除工作空间…」的 PromptDialog 输名确认（流程不变）。
// 全部标签关闭时内容由同文件导出的 ClosedWorkspacesPanel 承接重开。
import { useEffect, useRef, useState } from 'react';
import { X, Plus, Folder, Pencil, FolderOpen, Trash2 } from 'lucide-react';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { ipc } from '../../ipc/client';
import { CreateWorkspaceDialog } from '../workspace/CreateWorkspaceDialog';
import { ClosedTabsDropdown } from './ClosedTabsDropdown';
import { cn } from '../../lib/cn';
import { noDragStyle } from '../../lib/platform';
import { PromptDialog } from '../common/PromptDialog';
import { Button } from '../ui/Button';

/** 右键菜单状态：目标 workspace + 弹出坐标（fixed 定位） */
interface TabMenu {
  id: string;
  x: number;
  y: number;
}

export function WorkspaceTabs({ hideCreateButton = false }: { hideCreateButton?: boolean }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const closedIds = useWorkspaceStore((s) => s.closedIds);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const select = useWorkspaceStore((s) => s.select);
  const remove = useWorkspaceStore((s) => s.remove);
  const rename = useWorkspaceStore((s) => s.rename);

  // 可见标签 = 未关闭的 workspace（关闭 ≠ 删除，工作空间本体保留在磁盘）
  const visibleWorkspaces = workspaces.filter((ws) => !closedIds.includes(ws.id));

  const [showCreate, setShowCreate] = useState(false);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // 正在重命名的 workspace id（tab 内 inline input 替换名称显示）
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // 等待二次确认删除的 workspace id（PromptDialog 打开 = 非 null）
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (!menu) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null);
    };
    const onMouseDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [menu]);

  /**
   * 删除 workspace（仅右键菜单「删除工作空间…」入口）：弹 PromptDialog
   * 二次确认后走 store.remove。
   *
   * 为防止误删，破坏性确认采用「输入工作空间名称一致」二次确认模式：
   * 用户必须一字不差输入工作空间名才会真正触发删除。后端 delete handler 会
   * 删除工作空间目录及全部 git 历史，UI 文案显式说明不可恢复。
   */
  const handleDelete = (id: string): void => {
    const ws = workspaces.find((w) => w.id === id);
    if (!ws) return;
    setPendingDeleteId(id);
  };

  /** PromptDialog 二次确认提交：仅当输入名称与 ws.name 一致才调 store.remove。
   * 错配时 alert 提示并丢弃提交；store.remove 失败（IPC 异常）也走 alert。 */
  const submitDeleteConfirm = (value: string): void => {
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    if (!id) return;
    const ws = workspaces.find((w) => w.id === id);
    if (!ws) return;
    if (value.trim() !== ws.name) {
      window.alert(`输入的工作空间名称与「${ws.name}」不一致，已取消删除。`);
      return;
    }
    remove(id).catch((err: Error) => window.alert(err.message));
  };

  /** 打开 workspace 目录：失败（目录缺失等）alert 提示 */
  const handleOpenDirectory = (id: string): void => {
    ipc.workspace.openDirectory(id).catch((err: Error) => window.alert(err.message));
  };

  /** 进入重命名态：预填当前名称 */
  const startRename = (id: string): void => {
    const ws = workspaces.find((w) => w.id === id);
    if (!ws) return;
    setRenamingId(id);
    setRenameValue(ws.name);
  };

  /** 提交重命名：空名/名称未变直接退出；失败 alert 且本地名称不动（store 回滚语义） */
  const submitRename = (): void => {
    const id = renamingId;
    const name = renameValue.trim();
    setRenamingId(null);
    if (!id || !name) return;
    const current = workspaces.find((w) => w.id === id);
    if (!current || current.name === name) return;
    rename(id, name).catch((err: Error) => window.alert(err.message));
  };

  return (
    <div className="flex items-center gap-1 h-full min-w-0" style={noDragStyle}>
      <div role="tablist" className="flex items-center gap-1 h-full">
        {visibleWorkspaces.map((ws) => {
          const active = ws.id === activeWorkspaceId;
          const renaming = ws.id === renamingId;
          return (
            <div
              key={ws.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              className={cn(
                'group relative flex items-center gap-1.5 px-3 py-1 rounded-md text-xs cursor-pointer whitespace-nowrap',
                active
                  ? 'bg-surface-2 text-primary'
                  : 'text-secondary hover:text-primary',
              )}
              onClick={() => {
                if (!renaming) select(ws.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ id: ws.id, x: e.clientX, y: e.clientY });
              }}
            >
              {renaming ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submitRename();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setRenamingId(null);
                    }
                  }}
                  onBlur={() => setRenamingId(null)}
                  onClick={(e) => e.stopPropagation()}
                  className="rounded border border-accent-500 bg-surface-2 px-1 text-xs text-primary outline-none"
                  style={{ width: 100 }}
                />
              ) : (
                <>
                  <Folder size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-tertiary" />
                  <span className="truncate" style={{ maxWidth: 120 }}>
                    {ws.name}
                  </span>
                  <button
                    type="button"
                    aria-label={`关闭标签 ${ws.name}`}
                    title="关闭标签（工作空间保留）"
                    className="opacity-0 group-hover:opacity-100 px-0.5 text-tertiary hover:text-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(ws.id);
                    }}
                  >
                    <X size={12} strokeWidth={1.75} aria-hidden />
                  </button>
                  {active && (
                    <span className="absolute left-2.5 right-2.5 -bottom-px h-0.5 bg-accent-500 rounded-sm" />
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {!hideCreateButton && (
      <button
        type="button"
        aria-label="新建工作空间"
        title="新建工作空间"
        className="w-7 h-7 flex items-center justify-center rounded-md text-sm text-secondary hover:bg-surface-3 hover:text-primary"
        onClick={() => setShowCreate(true)}
      >
        <Plus size={14} strokeWidth={1.75} aria-hidden />
      </button>
      )}

      {/* 已关闭工作空间的重开入口（closedIds 非空才出现，空态零视觉噪音） */}
      <ClosedTabsDropdown />

      {showCreate && <CreateWorkspaceDialog onClose={() => setShowCreate(false)} />}

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 py-1 rounded-lg border border-subtle bg-surface-1 shadow-xl"
          style={{ ...noDragStyle, left: menu.x, top: menu.y, minWidth: 160 }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-secondary hover:bg-surface-3"
            onClick={() => {
              startRename(menu.id);
              setMenu(null);
            }}
          >
            <Pencil size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
            重命名
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-secondary hover:bg-surface-3"
            onClick={() => {
              handleOpenDirectory(menu.id);
              setMenu(null);
            }}
          >
            <FolderOpen size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
            打开目录
          </button>
          <div className="my-1 border-t border-subtle" aria-hidden="true" />
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-secondary hover:bg-surface-3"
            onClick={() => {
              closeTab(menu.id);
              setMenu(null);
            }}
          >
            <X size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
            关闭标签
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-status-error hover:bg-surface-3"
            onClick={() => {
              handleDelete(menu.id);
              setMenu(null);
            }}
          >
            <Trash2 size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
            删除工作空间…
          </button>
        </div>
      )}

      {pendingDeleteId !== null && (() => {
        const ws = workspaces.find((w) => w.id === pendingDeleteId);
        if (!ws) return null;
        return (
          <PromptDialog
            title="确认删除工作空间"
            label={`将删除工作空间目录及全部 git 历史，不可恢复。请输入工作空间名称「${ws.name}」以确认。`}
            placeholder={ws.name}
            onSubmit={submitDeleteConfirm}
            onClose={() => setPendingDeleteId(null)}
          />
        );
      })()}
    </div>
  );
}

/**
 * 全部工作空间标签关闭后的重开面板（D6 走查修复）：workspaces 非空但可见标签
 * 为空时由 App.tsx 渲染（TitleBar 下方占满内容区，与首启空态同构）。列出全部
 * workspace 各带「重新打开」按钮——reopenTab 移出 closedIds 并激活。
 */
export function ClosedWorkspacesPanel() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const reopenTab = useWorkspaceStore((s) => s.reopenTab);

  return (
    <div className="flex flex-1 min-h-0 items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-md rounded-lg border border-subtle bg-surface-1 p-5">
        <h2 className="text-sm font-semibold text-primary">已关闭全部工作空间标签</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-tertiary">
          工作空间仍保留在磁盘，可随时重新打开：
        </p>
        <ul className="mt-2">
          {workspaces.map((ws) => (
            <li
              key={ws.id}
              className="flex items-center justify-between gap-2 border-b border-subtle py-2 last:border-b-0"
            >
              <span className="flex min-w-0 items-center gap-2 text-sm text-primary">
                <Folder size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-tertiary" />
                <span className="truncate">{ws.name}</span>
              </span>
              <Button variant="ghost" size="sm" className="shrink-0" onClick={() => reopenTab(ws.id)}>
                重新打开
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
