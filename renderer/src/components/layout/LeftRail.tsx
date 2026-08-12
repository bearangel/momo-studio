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
  { key: 'marketplace', icon: '\u{1F6D2}', label: 'View: 资源库' },
  { key: 'settings', icon: '\u2699', label: 'View: Settings' },
];

export function LeftRail() {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);

  return (
    <div className="w-14 shrink-0 bg-bg-secondary border-r border-border-subtle flex flex-col items-center py-3 gap-2">
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
    </div>
  );
}
