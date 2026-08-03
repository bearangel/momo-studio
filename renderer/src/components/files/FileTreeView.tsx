// renderer/src/components/files/FileTreeView.tsx
// 递归文件树视图：按目录路径加载条目，渲染子目录（可展开/折叠）与文件（可选中）
import { useEffect, useState } from 'react';
import { useFileStore } from '../../stores/file.store';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { FileContextMenu } from './FileContextMenu';
import { PromptDialog } from '../common/PromptDialog';
import { cn } from '../../lib/cn';

interface Props {
  // 当前要渲染的目录路径（相对 workspace 根，根目录为 '.'）
  dirPath: string;
  // 缩进层级，每层 16px
  depth: number;
  // 选中文件时触发的外部回调
  onSelectFile: (filePath: string) => void;
}

export function FileTreeView({ dirPath, depth, onSelectFile }: Props) {
  const { tree, expandedDirs, selectedFile, selectedDir, loadDir, toggleDir, selectFile, selectDir, deletePath, renamePath, createPath } =
    useFileStore();
  const closeTabIfPath = useEditorStore((s) => s.closeTabIfPath);
  const renameTab = useEditorStore((s) => s.renameTab);
  const workspace = useWorkspaceStore((s) => s.getActive());

  // 右键菜单状态：记录触发位置、目标路径、是否目录
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; isDirectory: boolean } | null>(null);
  // 行内重命名状态：目标路径与当前输入值
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  // 移动目标目录输入状态
  const [moving, setMoving] = useState<{ path: string } | null>(null);
  // 目录内新建状态：目标目录 + 类型（file/dir）
  const [creatingInDir, setCreatingInDir] = useState<{ dir: string; type: 'file' | 'dir' } | null>(null);

  const entries = tree.get(dirPath);
  const expanded = expandedDirs.has(dirPath);

  // 目录条目未缓存时按需拉取（workspace 就绪且尚未加载过该目录）
  useEffect(() => {
    if (workspace && !entries) {
      void loadDir(workspace.id, dirPath);
    }
  }, [workspace, dirPath, entries, loadDir]);

  // 加载中占位
  if (!entries) {
    return (
      <div style={{ paddingLeft: depth * 16 }} className="text-neutral-500 text-sm">
        加载中…
      </div>
    );
  }

  // 根目录（dirPath === '.'）渲染折叠头行：点击 toggleDir('.') 切换整棵树的显隐
  const isRoot = dirPath === '.';

  return (
    <div>
      {isRoot && (
        <button
          type="button"
          onClick={() => toggleDir('.')}
          className="w-full text-left py-1 text-xs uppercase tracking-wide text-neutral-500 hover:bg-bg-tertiary flex items-center gap-1 rounded"
        >
          <span>{expanded ? '▼' : '▶'}</span>
          <span>工作区文件</span>
        </button>
      )}
      {(!isRoot || expanded) && entries.map((entry) => {
        // 拼接全路径：根目录下直接用文件名，否则拼上父路径
        const fullPath = dirPath === '.' ? entry.name : `${dirPath}/${entry.name}`;
        const isSelected = selectedFile === fullPath;

        // 目录节点：可展开/折叠，展开时递归渲染子树
        if (entry.isDirectory) {
          // 该子目录自身的展开态（区别于组件级根展开态 expanded）
          const entryExpanded = expandedDirs.has(fullPath);
          return (
            <div key={fullPath}>
              <button
                onClick={() => {
                  selectDir(fullPath);
                  toggleDir(fullPath);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, path: fullPath, isDirectory: true });
                }}
                className={cn(
                  'w-full text-left py-1 text-sm hover:bg-bg-tertiary flex items-center gap-1 rounded',
                  selectedDir === fullPath && 'bg-accent-blue/20',
                )}
                style={{ paddingLeft: depth * 16 }}
              >
                <span className="text-xs">{entryExpanded ? '▼' : '▶'}</span>
                <span>{entryExpanded ? '📂' : '📁'}</span>
                <span className="truncate">{entry.name}</span>
              </button>
              {entryExpanded && (
                <FileTreeView
                  dirPath={fullPath}
                  depth={depth + 1}
                  onSelectFile={onSelectFile}
                />
              )}
            </div>
          );
        }

        // 文件节点：点击时更新选中状态并通知外部
        return (
          <button
            key={fullPath}
            onClick={() => {
              selectFile(fullPath);
              onSelectFile(fullPath);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, path: fullPath, isDirectory: false });
            }}
            className={cn(
              'w-full text-left py-1 text-sm hover:bg-bg-tertiary flex items-center gap-1 rounded',
              isSelected && 'bg-accent-blue/20',
            )}
            style={{ paddingLeft: depth * 16 + 20 }}
          >
            <span>📄</span>
            <span className="truncate">{entry.name}</span>
          </button>
        );
      })}
      {menu && workspace && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          isDirectory={menu.isDirectory}
          onNewFile={
            menu.isDirectory
              ? () => setCreatingInDir({ dir: menu.path, type: 'file' })
              : undefined
          }
          onNewDir={
            menu.isDirectory
              ? () => setCreatingInDir({ dir: menu.path, type: 'dir' })
              : undefined
          }
          onRename={() =>
            setRenaming({ path: menu.path, value: menu.path.split('/').pop() ?? '' })
          }
          onDelete={async () => {
            const scope = menu.isDirectory ? '目录及其全部内容' : '该文件';
            if (!confirm(`确定删除${scope}？\n${menu.path}`)) return;
            await deletePath(workspace.id, menu.path);
            closeTabIfPath(menu.path);
          }}
          onMove={() => setMoving({ path: menu.path })}
          onClose={() => setMenu(null)}
        />
      )}
      {moving && workspace && (
        <PromptDialog
          title={`移动「${moving.path}」`}
          label="目标目录相对路径（如 src/utils）"
          placeholder="src/utils"
          onSubmit={async (dstDir) => {
            const path = moving.path;
            setMoving(null);
            if (!dstDir.trim()) return;
            const name = path.split('/').pop() ?? '';
            const dst = `${dstDir.trim().replace(/\/$/, '')}/${name}`;
            await renamePath(workspace.id, path, dst);
            renameTab(path, dst);
          }}
          onClose={() => setMoving(null)}
        />
      )}
      {creatingInDir && workspace && (
        <PromptDialog
          title={creatingInDir.type === 'file' ? `在「${creatingInDir.dir}」内新文件名` : `在「${creatingInDir.dir}」内新目录名`}
          placeholder={creatingInDir.type === 'file' ? '如 foo.ts' : '如 utils'}
          onSubmit={async (name) => {
            const dir = creatingInDir.dir;
            const type = creatingInDir.type;
            setCreatingInDir(null);
            if (!name.trim()) return;
            const fullPath = `${dir}/${name.trim()}`;
            try {
              await createPath(workspace.id, fullPath, type);
            } catch (e) {
              alert(`创建失败：${e instanceof Error ? e.message : String(e)}`);
            }
          }}
          onClose={() => setCreatingInDir(null)}
        />
      )}
      {renaming && workspace && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setRenaming(null)}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!renaming.value.trim()) {
                setRenaming(null);
                return;
              }
              // 保留原父目录，仅替换最后一段文件名
              const parent = renaming.path.includes('/')
                ? renaming.path.slice(0, renaming.path.lastIndexOf('/'))
                : '';
              const dst = parent ? `${parent}/${renaming.value.trim()}` : renaming.value.trim();
              await renamePath(workspace.id, renaming.path, dst);
              renameTab(renaming.path, dst);
              setRenaming(null);
            }}
            className="bg-bg-secondary border border-border-subtle rounded p-4 flex flex-col gap-2"
          >
            <label className="text-xs text-neutral-400">
              新名称
              <input
                value={renaming.value}
                onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                autoFocus
                className="mt-1 w-64 bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-sm text-neutral-100"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenaming(null)}
                className="text-xs text-neutral-400 px-2 py-1"
              >
                取消
              </button>
              <button type="submit" className="text-xs px-2 py-1 rounded bg-accent-blue text-white">
                确定
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
