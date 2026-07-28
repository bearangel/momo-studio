// renderer/src/components/layout/MiddlePanel.tsx
import { useUiStore } from '../../stores/ui.store';

const VIEW_ICON: Record<string, string> = {
  im: '\u{1F4AC}',
  files: '\u{1F4C1}',
  agents: '\u{1F916}',
  marketplace: '\u{1F6D2}',
  settings: '\u2699',
};

export function MiddlePanel() {
  const activeView = useUiStore((s) => s.activeView);

  // In M0 every view renders a placeholder. Real view content lands in later
  // tasks; the shell only proves routing + activeView wiring.
  return (
    <div className="flex-1 bg-bg-primary flex items-center justify-center">
      <div className="text-center text-neutral-500">
        <div className="text-4xl mb-3">{VIEW_ICON[activeView]}</div>
        <h2 className="text-xl font-semibold capitalize">{activeView}</h2>
        <p className="mt-1 text-sm">Coming soon in M1+</p>
      </div>
    </div>
  );
}
