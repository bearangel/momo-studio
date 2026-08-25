// renderer/src/components/files/FileTree.tsx
// 文件树入口组件：顶部工具条（刷新 / 全部折叠 / 新建）+ 从根目录 '.' 开始递归渲染。
// 工具栏新建按钮的落点跟随 selectedDir；切回 files 视图时刷新已缓存目录。
// 点击空白区选中根目录；右键空白区弹出根级操作菜单（VS Code 风格）。
import { useState, useEffect } from 'react';
import { FileTreeView } from './FileTreeView';
import { FileContextMenu } from './FileContextMenu';
import { PromptDialog } from '../common/PromptDialog';
import { useFileStore } from '../../stores/file.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useUiStore } from '../../stores/ui.store';

interface Props {
  // 选中文件时触发的外部回调（全路径相对 workspace 根）
  onSelectFile: (filePath: string) => void;
}

export function FileTree({ onSelectFile }: Props) {
  const collapseAll = useFileStore((s) => s.collapseAll);
  const refreshDir = useFileStore((s) => s.refreshDir);
  const initWorkspace = useFileStore((s) => s.initWorkspace);
  const workspace = useWorkspaceStore((s) => s.getActive());
  const activeView = useUiStore((s) => s.activeView);
  const selectedDir = useFileStore((s) => s.selectedDir);
  const [creating, setCreating] = useState<'file' | 'dir' | null>(null);
  // 空白区右键菜单位置
  const [emptyMenu, setEmptyMenu] = useState<{ x: number; y: number } | null>(null);

  // workspace 切换时加载该 workspace 的展开态（按 workspace 隔离持久化）
  useEffect(() => {
    if (workspace) initWorkspace(workspace.id);
  }, [workspace, initWorkspace]);

  // 切回文件视图时刷新所有已缓存目录（agent/外部/git 可能改动了文件）
  useEffect(() => {
    if (activeView === 'files' && workspace) {
      void useFileStore.getState().refreshAllCached(workspace.id);
    }
  }, [activeView, workspace]);

  // 刷新当前 workspace 根目录：失效缓存后重新拉取
  const handleRefresh = () => {
    if (workspace) {
      void refreshDir(workspace.id, '.');
    }
  };

  const handleCreate = async (name: string) => {
    const type = creating;
    setCreating(null);
    if (!name.trim() || !workspace || !type) return;
    // 根据当前选中目录拼接完整路径
    const targetDir = useFileStore.getState().selectedDir || '.';
    const fullPath = targetDir === '.' ? name.trim() : `${targetDir}/${name.trim()}`;
    try {
      await useFileStore.getState().createPath(workspace.id, fullPath, type);
    } catch (e) {
      alert(`创建失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 点击空白区（非文件/文件夹按钮）时选中根目录
  const handleEmptyClick = (e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest('button')) {
      useFileStore.getState().selectDir('.');
    }
  };

  // 右键空白区时选中根目录并弹出根级操作菜单
  const handleEmptyContextMenu = (e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest('button')) {
      e.preventDefault();
      useFileStore.getState().selectDir('.');
      setEmptyMenu({ x: e.clientX, y: e.clientY });
    }
  };

  // tooltip 文案：选中根目录时不显示「（到 .）」，子目录显示「（到 {dir}）」
  const targetLabel = selectedDir && selectedDir !== '.' ? `（到 ${selectedDir}）` : '';

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border-subtle bg-bg-secondary z-10">
        <button
          type="button"
          onClick={handleRefresh}
          title="刷新"
          className="text-xs text-neutral-400 hover:text-neutral-200 px-1"
        >
          🔄
        </button>
        <button
          type="button"
          onClick={collapseAll}
          title="全部折叠"
          className="text-xs text-neutral-400 hover:text-neutral-200 px-1"
        >
          折叠
        </button>
        <button
          type="button"
          onClick={() => workspace && setCreating('file')}
          disabled={!workspace}
          title={`新建文件${targetLabel}`}
          className="text-xs text-neutral-400 hover:text-neutral-200 px-1 disabled:opacity-40"
        >
          📄＋
        </button>
        <button
          type="button"
          onClick={() => workspace && setCreating('dir')}
          disabled={!workspace}
          title={`新建文件夹${targetLabel}`}
          className="text-xs text-neutral-400 hover:text-neutral-200 px-1 disabled:opacity-40"
        >
          📁＋
        </button>
      </div>
      <div
        className="flex-1 overflow-auto px-2 py-1"
        onClick={handleEmptyClick}
        onContextMenu={handleEmptyContextMenu}
      >
        <FileTreeView dirPath="." depth={0} onSelectFile={onSelectFile} />
      </div>
      {emptyMenu && (
        <FileContextMenu
          x={emptyMenu.x}
          y={emptyMenu.y}
          isDirectory={true}
          onNewFile={() => setCreating('file')}
          onNewDir={() => setCreating('dir')}
          onClose={() => setEmptyMenu(null)}
        />
      )}
      {creating && (
        <PromptDialog
          title={creating === 'file' ? `新文件名${targetLabel}` : `新目录名${targetLabel}`}
          placeholder={creating === 'file' ? '可含子目录，如 src/foo.ts' : '如 docs'}
          onSubmit={handleCreate}
          onClose={() => setCreating(null)}
        />
      )}
    </div>
  );
}
