// renderer/src/components/onboarding/CompleteStep.tsx
import { useEffect } from 'react';
import { Button } from '../ui/Button';

interface Props {
  onComplete: () => void;
}

export function CompleteStep({ onComplete }: Props) {
  useEffect(() => {
    const t = setTimeout(onComplete, 1500);
    return () => clearTimeout(t);
  }, [onComplete]);

  return (
    <div className="flex flex-col items-center gap-4 p-12">
      <div className="text-5xl" aria-hidden="true">✓</div>
      <h1 className="text-2xl font-bold">You're all set</h1>
      <p className="text-neutral-400">Taking you to your workspace…</p>
      <Button onClick={onComplete}>Continue</Button>
    </div>
  );
}