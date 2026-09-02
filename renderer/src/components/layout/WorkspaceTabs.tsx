// renderer/src/components/layout/WorkspaceTabs.tsx
//
// TitleBar 内的 workspace tab 条（P2 Task 2）：每个 workspace 一个 tab
// （图标 + 名称 + hover 关闭 lucide X），激活 tab 高亮 + 底部 accent 条；
// lucide Plus 打开新建对话框；tab 右键弹自绘轻量浮层菜单（重命名 inline input
// / 删除 confirm / 打开目录），Esc / 点击菜单外部关闭。整个 tab 条是交互区，
// 整体标 no-drag。
import { useEffect, useRef, useState } from 'react';
import { X, Plus } from 'lucide-react';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { ipc } from '../../ipc/client';
import { CreateWorkspaceDialog } from '../workspace/CreateWorkspaceDialog';
import { cn } from '../../lib/cn';
import { noDragStyle } from '../../lib/platform';
import { PromptDialog } from '../common/PromptDialog';

/** 右键菜单状态：目标 workspace + 弹出坐标（fixed 定位） */
interface TabMenu {
  id: string;
  x: number;
  y: number;
}

export function WorkspaceTabs() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const select = useWorkspaceStore((s) => s.select);
  const remove = useWorkspaceStore((s) => s.remove);
  const rename = useWorkspaceStore((s) => s.rename);

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
   * 删除 workspace（tab 上的 lucide X 按钮与右键菜单共用）：弹 PromptDialog
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
        {workspaces.map((ws) => {
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
                  <span className="text-xs leading-none">{ws.iconEmoji}</span>
                  <span className="truncate" style={{ maxWidth: 120 }}>
                    {ws.name}
                  </span>
                  <button
                    type="button"
                    aria-label={`关闭 ${ws.name}`}
                    className="opacity-0 group-hover:opacity-100 px-0.5 text-tertiary hover:text-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(ws.id);
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

      <button
        type="button"
        aria-label="新建工作空间"
        title="新建工作空间"
        className="w-7 h-7 flex items-center justify-center rounded-md text-sm text-secondary hover:bg-surface-3 hover:text-primary"
        onClick={() => setShowCreate(true)}
      >
        <Plus size={14} strokeWidth={1.75} aria-hidden />
      </button>

      {showCreate && <CreateWorkspaceDialog onClose={() => setShowCreate(false)} />}

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 py-1 rounded-lg border border-subtle bg-surface-1 shadow-xl"
          style={{ ...noDragStyle, left: menu.x, top: menu.y, minWidth: 140 }}
        >
          <button
            type="button"
            className="block w-full text-left px-3 py-1.5 text-xs text-secondary hover:bg-surface-3"
            onClick={() => {
              startRename(menu.id);
              setMenu(null);
            }}
          >
            重命名
          </button>
          <button
            type="button"
            className="block w-full text-left px-3 py-1.5 text-xs text-secondary hover:bg-surface-3"
            onClick={() => {
              handleOpenDirectory(menu.id);
              setMenu(null);
            }}
          >
            打开目录
          </button>
          <button
            type="button"
            className="block w-full text-left px-3 py-1.5 text-xs text-status-error hover:bg-surface-3"
            onClick={() => {
              handleDelete(menu.id);
              setMenu(null);
            }}
          >
            删除
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
