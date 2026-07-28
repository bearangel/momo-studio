// renderer/src/components/onboarding/ModeSelectStep.tsx
import { useState } from 'react';
import { Button } from '../ui/Button';
import { cn } from '../../lib/cn';

type Mode = 'standalone' | 'connect';

interface Props {
  onNext: (mode: Mode) => void;
  onBack: () => void;
}

export function ModeSelectStep({ onNext, onBack }: Props) {
  const [selected, setSelected] = useState<Mode>('standalone');

  return (
    <div className="flex flex-col gap-6 p-12">
      <h2 className="text-2xl font-bold">Choose mode</h2>
      <div className="flex gap-4">
        <button
          type="button"
          aria-label="standalone mode"
          className={cn(
            'flex-1 p-6 text-left rounded-lg border',
            selected === 'standalone'
              ? 'border-accent-blue bg-accent-blue/10'
              : 'border-border-subtle hover:border-border-strong',
          )}
          onClick={() => setSelected('standalone')}
        >
          <div className="text-lg font-semibold mb-2">Standalone (recommended)</div>
          <p className="text-sm text-neutral-400">
            Built-in homeserver runs locally. No external dependencies. Best for first-time use.
          </p>
        </button>
        <button
          type="button"
          aria-label="connect to existing homeserver (coming soon)"
          className="flex-1 p-6 text-left rounded-lg border border-border-subtle opacity-50 cursor-not-allowed"
          disabled
        >
          <div className="text-lg font-semibold mb-2">
            Connect to existing <span className="text-xs text-neutral-500">(Coming soon)</span>
          </div>
          <p className="text-sm text-neutral-400">
            Connect to a homeserver you already run. Available in v1.1.
          </p>
        </button>
      </div>
      <div className="flex gap-3 justify-end">
        <Button variant="ghost" onClick={onBack}>Back</Button>
        <Button onClick={() => onNext(selected)}>Continue</Button>
      </div>
    </div>
  );
}