// renderer/src/components/layout/SidebarRestoreButton.tsx
//
// 收起恢复按钮（v2.2 方案 A 顶行内联停靠，spec D3）：仅当「当前视图自己收起」且
// 当前视图有侧边栏时渲染（收起状态按视图独立，v2.2 优化），作为各视图主区顶行
// 第一个元素参与 flex 布局（文件视图 = tab 行首位，tab 依次右移，零遮挡）。
// 自读 ui.store，无 props。
import { PanelLeftOpen } from 'lucide-react';
import { SIDEBAR_VIEWS, useUiStore, type SidebarViewKey } from '../../stores/ui.store';

export function SidebarRestoreButton() {
  const activeView = useUiStore((s) => s.activeView);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const collapsed = useUiStore((s) =>
    (SIDEBAR_VIEWS as readonly string[]).includes(s.activeView)
      ? s.sidebarCollapsed[s.activeView as SidebarViewKey]
      : false,
  );

  // collapsed 为 true 蕴含 activeView ∈ SIDEBAR_VIEWS（上方 selector 的 includes 分支）
  if (!collapsed) return null;

  return (
    <button
      type="button"
      aria-label="展开侧边栏"
      title="展开侧边栏（Ctrl/Cmd+B）"
      data-testid="sidebar-restore-btn"
      onClick={() => toggleSidebar(activeView as SidebarViewKey)}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-surface-3 hover:text-primary"
    >
      <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden />
    </button>
  );
}
