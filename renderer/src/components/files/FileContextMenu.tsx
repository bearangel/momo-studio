// renderer/src/components/files/FileContextMenu.tsx
// 文件/目录右键菜单：目录级新建 + 重命名 / 删除 / 移动。位置由调用方通过 clientX/Y 传入。
interface Props {
  x: number;
  y: number;
  isDirectory: boolean;
  onRename: () => void;
  onDelete: () => void;
  onMove: () => void;
  onClose: () => void;
  /** 仅 isDirectory=true 时渲染：在该目录内新建文件 */
  onNewFile?: () => void;
  /** 仅 isDirectory=true 时渲染：在该目录内新建文件夹 */
  onNewDir?: () => void;
}

export function FileContextMenu({
  x,
  y,
  isDirectory,
  onRename,
  onDelete,
  onMove,
  onClose,
  onNewFile,
  onNewDir,
}: Props) {
  return (
    <>
      {/* 全屏遮罩：点击或右键关闭菜单 */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <ul
        className="fixed z-50 bg-bg-secondary border border-border-subtle rounded shadow-lg py-1 text-sm text-neutral-200 min-w-[120px]"
        style={{ left: x, top: y }}
      >
        {/* 目录级新建：仅在右键目标是目录时显示 */}
        {isDirectory && (
          <>
            {onNewFile && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    onNewFile();
                    onClose();
                  }}
                  className="w-full text-left px-3 py-1 hover:bg-bg-tertiary"
                >
                  新建文件
                </button>
              </li>
            )}
            {onNewDir && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    onNewDir();
                    onClose();
                  }}
                  className="w-full text-left px-3 py-1 hover:bg-bg-tertiary"
                >
                  新建文件夹
                </button>
              </li>
            )}
            <li className="border-t border-border-subtle my-1" />
          </>
        )}
        <li>
          <button
            type="button"
            onClick={() => {
              onRename();
              onClose();
            }}
            className="w-full text-left px-3 py-1 hover:bg-bg-tertiary"
          >
            重命名
          </button>
        </li>
        <li>
          <button
            type="button"
            onClick={() => {
              onMove();
              onClose();
            }}
            className="w-full text-left px-3 py-1 hover:bg-bg-tertiary"
          >
            移动到…
          </button>
        </li>
        <li className="border-t border-border-subtle my-1" />
        <li>
          <button
            type="button"
            onClick={() => {
              onDelete();
              onClose();
            }}
            className="w-full text-left px-3 py-1 hover:bg-bg-tertiary text-red-400"
          >
            删除{isDirectory ? '（含子项）' : ''}
          </button>
        </li>
      </ul>
    </>
  );
}
