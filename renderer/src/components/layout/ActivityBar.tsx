// renderer/src/components/layout/ActivityBar.tsx
//
// 活动栏：主区左侧固定图标列。5 个主项（会话/文件/看板/Agent/资源库）+ 底部设置项；
// 激活项左侧 3px accent 指示条 + surface-active 选中底。宽度用 inline style。
// v2.1 P1：emoji 图标全部 lucide 化，样式全 token 化。
import type { LucideIcon } from 'lucide-react';
import { MessageSquare, Folder, SquareKanban, Bot, Library, Settings } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useUiStore, SIDEBAR_VIEWS, type ViewKey } from '../../stores/ui.store';

interface ActivityItem {
  key: ViewKey;
  icon: LucideIcon;
  label: string;
}

const MAIN_ITEMS: ActivityItem[] = [
  { key: 'im', icon: MessageSquare, label: '会话' },
  { key: 'files', icon: Folder, label: '文件' },
  { key: 'tasks', icon: SquareKanban, label: '看板' },
  { key: 'agents', icon: Bot, label: 'Agent' },
  { key: 'marketplace', icon: Library, label: '资源库' },
];

const SETTINGS_ITEM: ActivityItem = { key: 'settings', icon: Settings, label: '设置' };

export function ActivityBar() {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  // 收起状态下点击「当前侧边栏视图」图标 → 恢复侧边栏（v2.2 恢复入口之三）；
  // 其余情况正常切换视图
  const handleSelect = (view: ViewKey): void => {
    if (
      view === activeView &&
      useUiStore.getState().sidebarCollapsed &&
      (SIDEBAR_VIEWS as readonly string[]).includes(view)
    ) {
      toggleSidebar();
      return;
    }
    setActiveView(view);
  };

  return (
    <nav
      className="shrink-0 border-r border-subtle bg-surface-1 flex flex-col items-center py-2.5 gap-1"
      style={{ width: 48 }}
      aria-label="活动栏"
    >
      {MAIN_ITEMS.map((item) => (
        <ActivityButton
          key={item.key}
          item={item}
          active={activeView === item.key}
          onSelect={handleSelect}
        />
      ))}
      <div className="flex-1" />
      <ActivityButton
        item={SETTINGS_ITEM}
        active={activeView === SETTINGS_ITEM.key}
        onSelect={handleSelect}
      />
    </nav>
  );
}

interface ActivityButtonProps {
  item: ActivityItem;
  active: boolean;
  onSelect: (view: ViewKey) => void;
}

function ActivityButton({ item, active, onSelect }: ActivityButtonProps) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      title={item.label}
      onClick={() => onSelect(item.key)}
      className={cn(
        'relative flex w-full flex-col items-center rounded-lg transition-colors',
        active
          ? 'bg-surface-active text-accent-600 dark:text-accent-300'
          : 'text-tertiary hover:bg-surface-3 hover:text-primary',
      )}
      style={{ padding: '6px 0 5px', gap: 3 }}
    >
      {active && (
        <span
          data-testid="activity-indicator"
          className="absolute bg-accent-500"
          style={{ left: 0, top: 8, bottom: 8, width: 3, borderRadius: 2 }}
        />
      )}
      <Icon size={17} strokeWidth={1.75} aria-hidden />
      <span style={{ fontSize: 9.5, lineHeight: 1 }}>{item.label}</span>
    </button>
  );
}
