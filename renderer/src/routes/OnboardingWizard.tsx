// renderer/src/routes/OnboardingWizard.tsx
//
// 新装引导向导（spec 2026-10-10 §3/§8）：取代 App.tsx 首启空态分支。
// 步骤状态本地持有（真实配置是唯一状态源——spec §3.2 幂等预填原则）。
// 各步骤组件分任务接线：本文件先立骨架与欢迎页，其余为占位推进件。
import { useState } from 'react';
import { TitleBar } from '../components/layout/TitleBar';
import { WelcomeStep } from '../components/onboarding/WelcomeStep';
import { ProviderStep } from '../components/onboarding/ProviderStep';
import { WorkspaceStep } from '../components/onboarding/WorkspaceStep';
import { RequirementStep } from '../components/onboarding/RequirementStep';
import { PlanPreviewStep } from '../components/onboarding/PlanPreviewStep';
import { ManualAgentStep } from '../components/onboarding/ManualAgentStep';
import { DoneStep } from '../components/onboarding/DoneStep';
import type { OnboardingPlan, OnboardingApplyResult } from '../ipc/types';
import { ipc } from '../ipc/client';

export type WizardRoute = 'ai' | 'manual';
export type WizardStep =
  | 'welcome'
  | 'provider'
  | 'workspace'
  | 'requirement'
  | 'preview'
  | 'manualAgents'
  | 'done';

/** 步骤组件共享上下文（骨架定义，各 Step 消费） */
export interface WizardCtx {
  route: WizardRoute;
  providerId: string;
  modelId: string;
  workspaceId: string;
  plan: OnboardingPlan | null;
  planWarnings: string[];
  applyResult: OnboardingApplyResult | null;
  setProvider: (providerId: string, modelId: string) => void;
  setWorkspace: (workspaceId: string) => void;
  setPlan: (plan: OnboardingPlan) => void;
  setPlanWarnings: (warnings: string[]) => void;
  setApplyResult: (result: OnboardingApplyResult) => void;
  go: (next: WizardStep) => void;
  /** 转手动：保留 provider/workspace 成果直达手动配置步（spec §8） */
  toManual: () => void;
  finish: () => void;
}

export function OnboardingWizard({ onFinished }: { onFinished: () => void }) {
  const [step, setStep] = useState<WizardStep>('welcome');
  const [route, setRoute] = useState<WizardRoute | null>(null);
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [plan, setPlan] = useState<OnboardingPlan | null>(null);
  const [planWarnings, setPlanWarnings] = useState<string[]>([]);
  const [applyResult, setApplyResult] = useState<OnboardingApplyResult | null>(null);

  // 状态判定收敛在 App（workspaces 空 + status pending 才挂载本向导）——
  // 此处不再重复查询（子 effect 先于父 effect 执行，双查会与 App 竞态消费）

  const ctx: WizardCtx = {
    route: route ?? 'manual',
    providerId,
    modelId,
    workspaceId,
    plan,
    planWarnings,
    applyResult,
    setProvider: (p, m) => {
      setProviderId(p);
      setModelId(m);
    },
    setWorkspace: setWorkspaceId,
    setPlan,
    setPlanWarnings,
    setApplyResult,
    go: setStep,
    toManual: () => {
      setRoute('manual');
      setStep('manualAgents');
    },
    finish: onFinished,
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-canvas">
      <TitleBar />
      <div className="flex-1 min-h-0 flex items-center justify-center p-6">
        {step === 'welcome' && (
          <WelcomeStep
            onSelect={(r) => {
              setRoute(r);
              setStep('provider');
            }}
            onSkip={async () => {
              await ipc.onboarding.markDone({ skipped: true });
              onFinished();
            }}
          />
        )}
        {step === 'provider' && <ProviderStep ctx={ctx} />}
        {step === 'workspace' && <WorkspaceStep ctx={ctx} />}
        {step === 'requirement' && <RequirementStep ctx={ctx} />}
        {step === 'preview' && <PlanPreviewStep ctx={ctx} />}
        {step === 'manualAgents' && <ManualAgentStep ctx={ctx} />}
        {step === 'done' && <DoneStep ctx={ctx} />}
      </div>
    </div>
  );
}
