// renderer/src/routes/Onboarding.tsx
import { useState } from 'react';
import { WelcomeStep } from '../components/onboarding/WelcomeStep';
import { ModeSelectStep } from '../components/onboarding/ModeSelectStep';
import { AccountSetupStep } from '../components/onboarding/AccountSetupStep';
import { CompleteStep } from '../components/onboarding/CompleteStep';

type Step = 'welcome' | 'mode' | 'account' | 'complete';

interface Props {
  onComplete: () => void;
}

export function Onboarding({ onComplete }: Props) {
  const [step, setStep] = useState<Step>('welcome');

  return (
    <div
      data-testid="onboarding"
      className="min-h-screen flex items-center justify-center bg-bg-primary"
    >
      <div className="w-full max-w-2xl bg-bg-secondary rounded-xl border border-border-subtle">
        {step === 'welcome' && <WelcomeStep onNext={() => setStep('mode')} />}
        {step === 'mode' && (
          <ModeSelectStep
            onNext={() => setStep('account')}
            onBack={() => setStep('welcome')}
          />
        )}
        {step === 'account' && (
          <AccountSetupStep
            onNext={() => setStep('complete')}
            onBack={() => setStep('mode')}
          />
        )}
        {step === 'complete' && <CompleteStep onComplete={onComplete} />}
      </div>
    </div>
  );
}