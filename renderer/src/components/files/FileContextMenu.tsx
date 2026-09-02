// renderer/src/components/files/FileContextMenu.tsx
// 文件/目录右键菜单：所有回调可选，按需渲染。
// 目录级新建（onNewFile/onNewDir）+ 重命名/移动/删除（onRename/onMove/onDelete）。
// 根级空白区菜单只传 onNewFile/onNewDir，不传文件操作项。
interface Props {
  x: number;
  y: number;
  isDirectory: boolean;
  onClose: () => void;
  /** 仅 isDirectory=true 时渲染：在该目录内新建文件 */
  onNewFile?: () => void;
  /** 仅 isDirectory=true 时渲染：在该目录内新建文件夹 */
  onNewDir?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onMove?: () => void;
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
  const hasNewItems = isDirectory && (onNewFile || onNewDir);
  const hasFileOps = onRename || onMove;

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
        className="fixed z-50 border border-subtle bg-surface-1 rounded shadow-lg py-1 text-sm text-secondary min-w-[120px]"
        style={{ left: x, top: y }}
      >
        {hasNewItems && (
          <>
            {onNewFile && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    onNewFile();
                    onClose();
                  }}
                  className="w-full text-left px-3 py-1 hover:bg-surface-3"
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
                  className="w-full text-left px-3 py-1 hover:bg-surface-3"
                >
                  新建文件夹
                </button>
              </li>
            )}
            {hasFileOps !== undefined && (hasFileOps || onDelete) && (
              <li className="border-t border-subtle my-1" />
            )}
          </>
        )}
        {onRename && (
          <li>
            <button
              type="button"
              onClick={() => {
                onRename();
                onClose();
              }}
              className="w-full text-left px-3 py-1 hover:bg-surface-3"
            >
              重命名
            </button>
          </li>
        )}
        {onMove && (
          <li>
            <button
              type="button"
              onClick={() => {
                onMove();
                onClose();
              }}
              className="w-full text-left px-3 py-1 hover:bg-surface-3"
            >
              移动到…
            </button>
          </li>
        )}
        {onDelete && (
          <>
            {hasFileOps && <li className="border-t border-subtle my-1" />}
            <li>
              <button
                type="button"
                onClick={() => {
                  onDelete();
                  onClose();
                }}
                className="w-full text-left px-3 py-1 hover:bg-surface-3 text-status-error"
              >
                删除{isDirectory ? '（含子项）' : ''}
              </button>
            </li>
          </>
        )}
      </ul>
    </>
  );
}
