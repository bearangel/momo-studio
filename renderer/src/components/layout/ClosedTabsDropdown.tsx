// renderer/src/components/layout/ClosedTabsDropdown.tsx
//
// 已关闭工作空间的常驻重开入口（2026-10-22 P1 预览方案批准）：
// tab 栏「+」右侧 History 图标钮，仅当 closedIds 非空时出现（空态整个
// 隐藏，tab 栏零视觉噪音）；点开列出全部已关闭 workspace，点击任意项即
// reopenTab（移出 closedIds 并激活）。Escape / 点击外部关闭——与
// WorkspaceTabs 右键菜单同一 dismiss 模式。全部关闭后 App 渲染的
// ClosedWorkspacesPanel 大面板保留为兜底，本入口只解决「还有其他标签
// 开着时已关闭空间不可见、不可重开」的场景（store / IPC 零改动）。
import { useEffect, useRef, useState } from 'react';
import { Folder, History } from 'lucide-react';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { cn } from '../../lib/cn';
import { noDragStyle } from '../../lib/platform';

export function ClosedTabsDropdown() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const closedIds = useWorkspaceStore((s) => s.closedIds);
  const reopenTab = useWorkspaceStore((s) => s.reopenTab);

  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  // dismiss：Escape / 点击锚点外部关闭（与 WorkspaceTabs 右键菜单同一模式）。
  // hook 必须先于下方空态早退调用，保证 hook 次序跨渲染稳定。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onMouseDown = (e: MouseEvent): void => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [open]);

  // 已关闭 workspace（保持 closedIds 的关闭先后次序）；空 → 整个入口不渲染
  const closedWorkspaces = workspaces.filter((ws) => closedIds.includes(ws.id));
  if (closedWorkspaces.length === 0) return null;

  return (
    <div ref={anchorRef} className="relative flex items-center">
      <button
        type="button"
        aria-label="已关闭的工作空间"
        aria-haspopup="menu"
        aria-expanded={open}
        title="已关闭的工作空间"
        className={cn(
          'w-7 h-7 flex items-center justify-center rounded-md text-sm text-secondary hover:bg-surface-3 hover:text-primary',
          open && 'bg-surface-3 text-primary',
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <History size={14} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          // minWidth 216：已批准预览定值——absolute 容器 shrink-to-fit，短名
          // workspace 会把面板压窄到标题「已关闭的工作空间」折行（2026-10-22
          // 用户 dev 环境实测），定最小宽保证任何名字下面板宽度一致
          className="absolute right-0 top-full z-50 mt-1 py-1 rounded-lg border border-subtle bg-surface-1 shadow-xl"
          style={{ ...noDragStyle, minWidth: 216 }}
        >
          <div className="whitespace-nowrap px-3 pb-0.5 pt-1 text-xs text-tertiary">已关闭的工作空间</div>
          {/* 条目多时纵向滚动（max-h-60 ≈ 10 行） */}
          <div className="max-h-60 overflow-y-auto">
            {closedWorkspaces.map((ws) => (
              <button
                key={ws.id}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-secondary hover:bg-surface-3 hover:text-primary"
                onClick={() => {
                  setOpen(false);
                  reopenTab(ws.id);
                }}
              >
                <Folder size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-tertiary" />
                <span className="truncate" style={{ maxWidth: 160 }}>
                  {ws.name}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
