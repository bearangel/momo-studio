// renderer/src/components/files/FileContextMenu.tsx
// 文件/目录右键菜单：所有回调可选，按需渲染。
// 三组条目：目录级新建（onNewFile/onNewDir）→ shell 组（外部应用打开 /
// 打开所在目录 / 复制路径，2026-10-11 功能优化）→ 重命名/移动/删除。
// 根级空白区菜单只传 onNewFile/onNewDir，不传文件操作项。
import { cn } from '../../lib/cn';

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
  /** 用系统默认应用打开（文件与目录通用；二进制文件的显式入口） */
  onOpenExternal?: () => void;
  /** 在系统文件管理器中显示该项（在其所在目录内选中） */
  onReveal?: () => void;
  /** 复制 OS 绝对路径到剪贴板 */
  onCopyPath?: () => void;
}

/** 单个菜单项：点击执行动作后统一关闭菜单 */
function MenuButton({
  label,
  onAction,
  onClose,
  danger = false,
}: {
  label: string;
  onAction: () => void;
  onClose: () => void;
  danger?: boolean;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          onAction();
          onClose();
        }}
        className={cn('w-full text-left px-3 py-1 hover:bg-surface-3', danger && 'text-status-error')}
      >
        {label}
      </button>
    </li>
  );
}

/** 组间分隔线 */
function MenuSeparator(): JSX.Element {
  return <li className="border-t border-subtle my-1" />;
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
  onOpenExternal,
  onReveal,
  onCopyPath,
}: Props) {
  const hasNewItems = isDirectory && (onNewFile || onNewDir);
  const hasEditItems = onRename || onMove;
  const hasShellItems = onOpenExternal || onReveal || onCopyPath;

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
            {onNewFile && <MenuButton label="新建文件" onAction={onNewFile} onClose={onClose} />}
            {onNewDir && <MenuButton label="新建文件夹" onAction={onNewDir} onClose={onClose} />}
            {(hasShellItems || hasEditItems || onDelete) && <MenuSeparator />}
          </>
        )}
        {hasShellItems && (
          <>
            {onOpenExternal && (
              <MenuButton label="用外部应用打开" onAction={onOpenExternal} onClose={onClose} />
            )}
            {onReveal && (
              <MenuButton label="打开所在目录" onAction={onReveal} onClose={onClose} />
            )}
            {onCopyPath && <MenuButton label="复制路径" onAction={onCopyPath} onClose={onClose} />}
            {hasEditItems && <MenuSeparator />}
          </>
        )}
        {onRename && <MenuButton label="重命名" onAction={onRename} onClose={onClose} />}
        {onMove && <MenuButton label="移动到…" onAction={onMove} onClose={onClose} />}
        {onDelete && (
          <>
            {(onRename || onMove || hasShellItems) && <MenuSeparator />}
            <MenuButton
              label={`删除${isDirectory ? '（含子项）' : ''}`}
              onAction={onDelete}
              onClose={onClose}
              danger
            />
          </>
        )}
      </ul>
    </>
  );
}
