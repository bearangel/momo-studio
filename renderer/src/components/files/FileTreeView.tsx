// renderer/src/components/files/FileTreeView.tsx
// 递归文件树视图：按目录路径加载条目，渲染子目录（可展开/折叠）与文件（可选中）
import { useEffect } from 'react';
import { useFileStore } from '../../stores/file.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
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
  const { tree, expandedDirs, selectedFile, loadDir, toggleDir, selectFile } =
    useFileStore();
  const workspace = useWorkspaceStore((s) => s.getActive());

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
                onClick={() => toggleDir(fullPath)}
                className={cn(
                  'w-full text-left py-1 text-sm hover:bg-bg-tertiary flex items-center gap-1 rounded',
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
    </div>
  );
}
