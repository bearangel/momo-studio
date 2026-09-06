// renderer/src/components/layout/SidebarRestoreButton.tsx
//
// 收起恢复按钮（v2.2 方案 A 顶行内联停靠，spec D3）：仅当侧边栏收起且当前
// 视图有侧边栏时渲染，作为各视图主区顶行第一个元素参与 flex 布局（文件视图
// = tab 行首位，tab 依次右移，零遮挡）。自读 ui.store，无 props。
import { PanelLeftOpen } from 'lucide-react';
import { SIDEBAR_VIEWS, useUiStore } from '../../stores/ui.store';

export function SidebarRestoreButton() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const activeView = useUiStore((s) => s.activeView);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  if (!collapsed || !(SIDEBAR_VIEWS as readonly string[]).includes(activeView)) return null;

  return (
    <button
      type="button"
      aria-label="展开侧边栏"
      title="展开侧边栏（Ctrl/Cmd+B）"
      data-testid="sidebar-restore-btn"
      onClick={toggleSidebar}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-surface-3 hover:text-primary"
    >
      <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden />
    </button>
  );
}