// renderer/src/routes/Onboarding.tsx
import { useState } from 'react';
import { useAuthStore } from '../stores/auth.store';
import { WelcomeStep } from '../components/onboarding/WelcomeStep';
import { ModeSelectStep } from '../components/onboarding/ModeSelectStep';
import { AccountSetupStep } from '../components/onboarding/AccountSetupStep';
import { CompleteStep } from '../components/onboarding/CompleteStep';
import { LoginStep } from '../components/onboarding/LoginStep';

type Step = 'welcome' | 'mode' | 'account' | 'login' | 'complete';

interface Props {
  onComplete: () => void;
}

export function Onboarding({ onComplete }: Props) {
  const wasAuthenticated = useAuthStore((s) => s.wasAuthenticated);
  // v1.5.7: 曾有会话（退出/token 过期）直接显示登录，首次使用走注册向导
  const [step, setStep] = useState<Step>(wasAuthenticated ? 'login' : 'welcome');

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
            onSwitchToLogin={() => setStep('login')}
          />
        )}
        {step === 'login' && (
          <LoginStep
            onComplete={onComplete}
            onSwitchToRegister={() => setStep('welcome')}
          />
        )}
        {step === 'complete' && <CompleteStep onComplete={onComplete} />}
      </div>
    </div>
  );
}