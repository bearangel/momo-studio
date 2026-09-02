// renderer/src/components/layout/TitleBar.tsx
//
// 顶部标题栏：Logo + workspace tabs + 拖拽区 + 窗口控件。
// win/linux 自绘窗口控件（lucide 图标）；mac 留给原生红绿灯（不渲染 Logo 与控件）。
// v2.1 P1：字形图标（◉▢❐─✕）全部 lucide 化，样式 token 化（品牌渐变改 accent 实底）。
import { useEffect, useState, type ReactNode } from 'react';
import { Minus, Square, Copy, X, Sparkles } from 'lucide-react';
import { isMac, dragStyle, noDragStyle } from '../../lib/platform';
import { WorkspaceTabs } from './WorkspaceTabs';
import { ipc } from '../../ipc/client';
import { cn } from '../../lib/cn';

export function TitleBar() {
  const mac = isMac();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // 初始查询一次 + 订阅主进程 maximize/unmaximize 推送（切换 还原/最大化 图标）
    void ipc.window.isMaximized().then(setMaximized);
    return ipc.window.onMaximizedChanged(setMaximized);
  }, []);

  return (
    <header
      className="h-10 shrink-0 flex items-center gap-1 border-b border-subtle bg-surface-1 px-2 select-none"
      style={dragStyle}
    >
      {!mac && (
        <span className="flex items-center gap-1.5 pl-1 pr-2 text-xs text-secondary">
          <span
            className="flex items-center justify-center rounded-md bg-accent-500 text-inverse"
            style={{ width: 18, height: 18 }}
          >
            <Sparkles size={11} strokeWidth={2} aria-hidden />
          </span>
          Momo Studio
        </span>
      )}
      {/* mac 原生红绿灯占位 ~78x28，把第一个 tab 让出来避免被遮 */}
      {mac && <div style={{ width: 78 }} className="shrink-0" />}
      <WorkspaceTabs />
      {/* tabs 与窗口控件之间的空白拖拽区 */}
      <div className="flex-1 h-full" />
      {!mac && (
        <div className="flex h-full" style={noDragStyle}>
          <WinCtlBtn ariaLabel="最小化" onClick={() => ipc.window.minimize()}>
            <Minus size={12} strokeWidth={1.75} aria-hidden />
          </WinCtlBtn>
          <WinCtlBtn
            ariaLabel={maximized ? '还原' : '最大化'}
            onClick={() => ipc.window.toggleMaximize()}
          >
            {maximized ? (
              <Copy size={12} strokeWidth={1.75} aria-hidden />
            ) : (
              <Square size={12} strokeWidth={1.75} aria-hidden />
            )}
          </WinCtlBtn>
          <WinCtlBtn ariaLabel="关闭" danger onClick={() => ipc.window.close()}>
            <X size={12} strokeWidth={1.75} aria-hidden />
          </WinCtlBtn>
        </div>
      )}
    </header>
  );
}

interface WinCtlBtnProps {
  ariaLabel: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}

/** 自绘窗口控制按钮（44px 宽，hover 高亮；关闭按钮 hover 红） */
function WinCtlBtn({ ariaLabel, onClick, danger, children }: WinCtlBtnProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        'flex h-full w-11 items-center justify-center text-secondary hover:text-primary',
        danger ? 'hover:bg-status-error hover:text-inverse' : 'hover:bg-surface-3',
      )}
    >
      {children}
    </button>
  );
}
