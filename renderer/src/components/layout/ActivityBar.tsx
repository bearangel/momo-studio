// renderer/src/components/layout/ActivityBar.tsx
//
// 活动栏（P2 Task 3）：主区左侧固定图标列（原型 .activity 段）。
// 5 个主项（会话/文件/看板/Agent/资源库）+ 底部设置项；每项 = 图标 + 9.5px 文字标签；
// 激活项左侧 3px 蓝色指示条。宽度用 inline style（Tailwind 任意值 class 不生成 CSS）。
import { cn } from '../../lib/cn';
import { useUiStore, type ViewKey } from '../../stores/ui.store';

interface ActivityItem {
  key: ViewKey;
  icon: string;
  label: string;
}

const MAIN_ITEMS: ActivityItem[] = [
  { key: 'im', icon: '💬', label: '会话' },
  { key: 'files', icon: '📁', label: '文件' },
  { key: 'tasks', icon: '📋', label: '看板' },
  { key: 'agents', icon: '🤖', label: 'Agent' },
  { key: 'marketplace', icon: '🧩', label: '资源库' },
];

const SETTINGS_ITEM: ActivityItem = { key: 'settings', icon: '⚙️', label: '设置' };

export function ActivityBar() {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);

  return (
    <nav
      className="shrink-0 bg-bg-primary border-r border-border-subtle flex flex-col items-center py-2.5 gap-1"
      style={{ width: 48 }}
      aria-label="活动栏"
    >
      {MAIN_ITEMS.map((item) => (
        <ActivityButton
          key={item.key}
          item={item}
          active={activeView === item.key}
          onSelect={setActiveView}
        />
      ))}
      <div className="flex-1" />
      <ActivityButton
        item={SETTINGS_ITEM}
        active={activeView === SETTINGS_ITEM.key}
        onSelect={setActiveView}
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
  return (
    <button
      type="button"
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      title={item.label}
      onClick={() => onSelect(item.key)}
      className={cn(
        'relative w-full flex flex-col items-center rounded-lg transition-colors',
        active ? 'bg-bg-tertiary text-white' : 'text-neutral-400 hover:bg-bg-tertiary/60 hover:text-neutral-200',
      )}
      style={{ padding: '6px 0 5px', gap: 3 }}
    >
      {active && (
        <span
          data-testid="activity-indicator"
          className="absolute bg-accent-blue"
          style={{ left: 0, top: 8, bottom: 8, width: 3, borderRadius: 2 }}
        />
      )}
      <span style={{ fontSize: 17, lineHeight: 1 }}>{item.icon}</span>
      <span style={{ fontSize: 9.5, lineHeight: 1 }}>{item.label}</span>
    </button>
  );
}
