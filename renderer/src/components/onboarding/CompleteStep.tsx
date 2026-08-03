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
      <h1 className="text-2xl font-bold">设置完成</h1>
      <p className="text-neutral-400">正在进入你的工作空间…</p>
      <Button onClick={onComplete}>继续</Button>
    </div>
  );
}