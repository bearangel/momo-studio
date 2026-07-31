// renderer/src/components/files/FileTree.tsx
// 文件树入口组件：顶部工具条（刷新 / 全部折叠）+ 从根目录 '.' 开始递归渲染，纵向排列并可滚动
import { FileTreeView } from './FileTreeView';
import { useFileStore } from '../../stores/file.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

interface Props {
  // 选中文件时触发的外部回调（全路径相对 workspace 根）
  onSelectFile: (filePath: string) => void;
}

export function FileTree({ onSelectFile }: Props) {
  const collapseAll = useFileStore((s) => s.collapseAll);
  const refreshDir = useFileStore((s) => s.refreshDir);
  const workspace = useWorkspaceStore((s) => s.getActive());

  // 刷新当前 workspace 根目录：失效缓存后重新拉取
  const handleRefresh = () => {
    if (workspace) {
      void refreshDir(workspace.id, '.');
    }
  };

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border-subtle sticky top-0 bg-bg-secondary z-10">
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
      </div>
      <FileTreeView dirPath="." depth={0} onSelectFile={onSelectFile} />
    </div>
  );
}
