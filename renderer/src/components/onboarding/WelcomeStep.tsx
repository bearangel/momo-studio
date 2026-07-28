// renderer/src/components/onboarding/WelcomeStep.tsx
import { Button } from '../ui/Button';

interface Props {
  onNext: () => void;
}

export function WelcomeStep({ onNext }: Props) {
  return (
    <div className="flex flex-col items-center gap-8 p-12">
      <h1 className="text-4xl font-bold">Welcome to AgentPlatform</h1>
      <p className="text-lg text-neutral-400 max-w-md text-center">
        A local-first multi-agent collaboration platform. Set up your workspace in a few steps.
      </p>
      <Button onClick={onNext} size="lg">Get started</Button>
    </div>
  );
}