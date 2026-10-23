// renderer/src/components/im/SessionContextMenu.tsx
// 会话列表右键菜单（2026-10-22 右键菜单改造 · 预览批准定值）。
// 模式照 FileContextMenu：fixed 定位 + 全屏遮罩（点击/右键关闭）+ 条目点击后
// 统一关闭 + danger 红字；两点补齐：Escape 关闭、视口边缘钳制（右缘/下缘
// 溢出回移）。会话行菜单与组头菜单共享外壳（MenuShell）。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** 视口钳制边距：菜单与视口边缘的最小留白（px） */
const VIEWPORT_MARGIN = 8;

/** 单个菜单项：点击执行动作后统一关闭菜单。hover 反馈走双通道
 *  （surface-active 背景 + 文字提亮）；danger 项 hover 文字保持红 */
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
        className={cn(
          // 预览定值：item 内边距 px-3 py-[5px]、字号 13px
          'w-full text-left px-3 py-[5px] hover:bg-surface-active hover:text-primary',
          danger && 'text-status-error hover:text-status-error',
        )}
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

/** 共享外壳：遮罩 + 定位菜单（min-w 132px 预览定值）+ Escape + 视口钳制 */
function MenuShell({
  x,
  y,
  testId,
  onClose,
  children,
}: {
  x: number;
  y: number;
  testId: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  const menuRef = useRef<HTMLUListElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 钳制需菜单实际尺寸：mount 后测量再回移（jsdom offsetWidth=0 同逻辑不炸）
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    setPos({
      left: Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth - VIEWPORT_MARGIN)),
      top: Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight - VIEWPORT_MARGIN)),
    });
  }, [x, y]);

  return (
    <>
      {/* 全屏遮罩：点击或右键关闭菜单 */}
      <div
        data-testid="context-menu-overlay"
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <ul
        ref={menuRef}
        data-testid={testId}
        className="fixed z-50 border border-subtle bg-surface-1 rounded-md shadow-lg py-1 text-[13px] text-secondary min-w-[132px]"
        style={{ left: pos.left, top: pos.top }}
      >
        {children}
      </ul>
    </>
  );
}

/** 会话行右键菜单：置顶切换 / 移入分组 / 重命名 ‖ 解散会话（danger） */
export function SessionContextMenu({
  x,
  y,
  pinned,
  onTogglePin,
  onMove,
  onRename,
  onDissolve,
  onClose,
}: {
  x: number;
  y: number;
  /** 会话当前置顶态（切换首条目文案） */
  pinned: boolean;
  onTogglePin: () => void;
  onMove: () => void;
  onRename: () => void;
  onDissolve: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <MenuShell x={x} y={y} testId="session-context-menu" onClose={onClose}>
      <MenuButton label={pinned ? '取消置顶' : '置顶'} onAction={onTogglePin} onClose={onClose} />
      <MenuButton label="移入分组…" onAction={onMove} onClose={onClose} />
      <MenuButton label="重命名" onAction={onRename} onClose={onClose} />
      <MenuSeparator />
      <MenuButton label="解散会话" onAction={onDissolve} onClose={onClose} danger />
    </MenuShell>
  );
}

/** 组头右键菜单：设置组色 / 重命名分组 ‖ 删除分组（danger） */
export function GroupContextMenu({
  x,
  y,
  onPalette,
  onRename,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  onPalette: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <MenuShell x={x} y={y} testId="group-context-menu" onClose={onClose}>
      <MenuButton label="设置组色" onAction={onPalette} onClose={onClose} />
      <MenuButton label="重命名分组" onAction={onRename} onClose={onClose} />
      <MenuSeparator />
      <MenuButton label="删除分组" onAction={onDelete} onClose={onClose} danger />
    </MenuShell>
  );
}

/** 批量右键菜单（多选>1）：移入分组… (N) ‖ 解散会话 ×N（danger）；
 *  无置顶/重命名——批量语义只保留整批可作用的操作（预览批准定值） */
export function BatchSessionContextMenu({
  x,
  y,
  count,
  onMove,
  onDissolve,
  onClose,
}: {
  x: number;
  y: number;
  count: number;
  onMove: () => void;
  onDissolve: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <MenuShell x={x} y={y} testId="batch-context-menu" onClose={onClose}>
      <MenuButton label={`移入分组… (${count})`} onAction={onMove} onClose={onClose} />
      <MenuSeparator />
      <MenuButton label={`解散会话 ×${count}`} onAction={onDissolve} onClose={onClose} danger />
    </MenuShell>
  );
}
