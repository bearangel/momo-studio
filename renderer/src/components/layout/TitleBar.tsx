// renderer/src/components/layout/TitleBar.tsx
//
// 顶部标题栏（P2 Task 2）：Logo + workspace tabs + ＋ + 拖拽区 + 窗口控件。
// win/linux 自绘窗口控件；mac 留给原生红绿灯（不渲染 Logo 与控件）。
// 整条 -webkit-app-region: drag 可拖动窗口；tab/按钮等交互元素标 no-drag。
import { useEffect, useState } from 'react';
import { isMac, dragStyle, noDragStyle } from '../../lib/platform';
import { WorkspaceTabs } from './WorkspaceTabs';
import { ipc } from '../../ipc/client';
import { cn } from '../../lib/cn';

export function TitleBar() {
  const mac = isMac();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // 初始查询一次 + 订阅主进程 maximize/unmaximize 推送（切换 ▢/❐ 图标）
    void ipc.window.isMaximized().then(setMaximized);
    return ipc.window.onMaximizedChanged(setMaximized);
  }, []);

  return (
    <header
      className="h-10 shrink-0 flex items-center gap-1 bg-bg-secondary border-b border-border-subtle px-2 select-none"
      style={dragStyle}
    >
      {!mac && (
        <span className="flex items-center gap-1.5 pl-1 pr-2 text-xs text-neutral-400">
          <span
            className="flex items-center justify-center bg-gradient-to-br from-accent-blue to-accent-purple text-white"
            style={{ width: 18, height: 18, borderRadius: 5, fontSize: 11 }}
          >
            ◉
          </span>
          Momo Studio
        </span>
      )}
      <WorkspaceTabs />
      {/* tabs 与窗口控件之间的空白拖拽区 */}
      <div className="flex-1 h-full" />
      {!mac && (
        <div className="flex h-full" style={noDragStyle}>
          <WinCtlBtn ariaLabel="最小化" glyph="─" onClick={() => ipc.window.minimize()} />
          <WinCtlBtn
            ariaLabel={maximized ? '还原' : '最大化'}
            glyph={maximized ? '❐' : '▢'}
            onClick={() => ipc.window.toggleMaximize()}
          />
          <WinCtlBtn ariaLabel="关闭" glyph="✕" danger onClick={() => ipc.window.close()} />
        </div>
      )}
    </header>
  );
}

interface WinCtlBtnProps {
  ariaLabel: string;
  glyph: string;
  onClick: () => void;
  danger?: boolean;
}

/** 自绘窗口控制按钮（原型 winctl：44px 宽，hover 高亮；关闭按钮 hover 红） */
function WinCtlBtn({ ariaLabel, glyph, onClick, danger }: WinCtlBtnProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        'w-11 h-full flex items-center justify-center text-xs text-neutral-400 hover:text-white',
        danger ? 'hover:bg-status-error' : 'hover:bg-bg-tertiary',
      )}
    >
      {glyph}
    </button>
  );
}
