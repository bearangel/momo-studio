// renderer/src/components/files/FileTree.tsx
// 文件树入口组件：从根目录 '.' 开始递归渲染，纵向排列并可滚动
import { FileTreeView } from './FileTreeView';

interface Props {
  // 选中文件时触发的外部回调（全路径相对 workspace 根）
  onSelectFile: (filePath: string) => void;
}

export function FileTree({ onSelectFile }: Props) {
  return (
    <div className="flex flex-col h-full overflow-auto">
      <FileTreeView dirPath="." depth={0} onSelectFile={onSelectFile} />
    </div>
  );
}
