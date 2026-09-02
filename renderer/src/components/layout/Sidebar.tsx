// renderer/src/components/layout/Sidebar.tsx
//
// 侧边栏容器（P2 Task 3）：ViewSidebar 的外壳。
// 展开 260px 承载内容；折叠 48px 仅显示当前视图图标（点击展开）。
// 折叠/展开由 ui.store.sidebarCollapsed（Ctrl/Cmd+B / 折叠轨点击）驱动。
import type { ReactNode } from 'react';

interface SidebarProps {
  collapsed: boolean;
  /** 折叠态显示的视图图标 */
  icon: ReactNode;
  label: string;
  onToggle: () => void;
  children?: ReactNode;
}

export function Sidebar({ collapsed, icon, label, onToggle, children }: SidebarProps) {
  if (collapsed) {
    return (
      <div
        data-testid="view-sidebar"
        className="shrink-0 border-r border-subtle bg-surface-1 flex flex-col items-center justify-center"
        style={{ width: 48 }}
      >
        <button
          type="button"
          aria-label="展开侧边栏"
          title={`展开${label}侧边栏（Ctrl/Cmd+B）`}
          onClick={onToggle}
          className="flex w-full flex-col items-center rounded-lg py-2 text-tertiary transition-colors hover:bg-surface-3 hover:text-primary"
        >
          <span style={{ lineHeight: 1 }}>{icon}</span>
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="view-sidebar"
      className="shrink-0 border-r border-subtle bg-surface-1 flex flex-col overflow-hidden"
      style={{ width: 260 }}
    >
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">{children}</div>
    </div>
  );
}
