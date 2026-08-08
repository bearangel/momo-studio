// renderer/src/components/layout/LeftRail.tsx
import { cn } from '../../lib/cn';
import { useUiStore, type ViewKey } from '../../stores/ui.store';
import { WorkspaceSwitcher } from '../workspace/WorkspaceSwitcher';

interface NavItem {
  key: ViewKey;
  icon: string;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'im', icon: '\u{1F4AC}', label: 'View: IM' },
  { key: 'files', icon: '\u{1F4C1}', label: 'View: Files' },
  { key: 'agents', icon: '\u{1F916}', label: 'View: Agents' },
  { key: 'marketplace', icon: '\u{1F6D2}', label: 'View: Marketplace' },
  { key: 'settings', icon: '\u2699', label: 'View: Settings' },
];

export function LeftRail() {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  return (
    <div
      className={cn(
        'shrink-0 bg-bg-secondary border-r border-border-subtle flex flex-col items-center py-3 gap-2 transition-all duration-300 overflow-hidden',
        collapsed ? 'w-0 border-r-0' : 'w-14',
      )}
    >
      <div className="relative">
        <WorkspaceSwitcher />
      </div>
      <div className="w-8 h-px bg-border-subtle my-1" />
      {NAV_ITEMS.map((item) => (
        <button
          key={item.key}
          type="button"
          aria-label={item.label}
          title={item.label.replace('View: ', '')}
          aria-current={activeView === item.key ? 'page' : undefined}
          onClick={() => setActiveView(item.key)}
          className={cn(
            'w-10 h-10 flex items-center justify-center rounded-md text-xl transition-colors',
            activeView === item.key
              ? 'bg-accent-blue/20 border border-accent-blue/50'
              : 'border border-transparent hover:bg-bg-tertiary',
          )}
        >
          {item.icon}
        </button>
      ))}
      {/* v1.5.7: 底部收起按钮 */}
      <div className="mt-auto">
        <button
          type="button"
          onClick={toggleSidebar}
          title="收起侧边栏"
          className="w-10 h-10 flex items-center justify-center rounded-md text-lg text-neutral-400 hover:bg-bg-tertiary"
        >
          ◀
        </button>
      </div>
    </div>
  );
}
