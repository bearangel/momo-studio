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
/** D11 步骤锚点条：首屏上部空高的锚点填充 + 全程位置感。当前段 accent 高亮。
 * Oracle 终审修正：真实流程 DAG 是 welcome→provider→workspace→requirement/preview
 * （WorkspaceStep 自证「已完成的模型服务与工作空间不会丢失」）——4 段单调映射，
 * 段 4 按 route 动态（AI=AI 规划 / 手动=选择智能体），进度点不回退。 */
function StepAnchorBar({ step, route }: { step: WizardStep; route: WizardRoute }): React.JSX.Element {
  const labels = ['1 欢迎', '2 模型服务', '3 工作空间', route === 'ai' ? '4 AI 规划' : '4 选择智能体'];
  const idx =
    step === 'welcome'
      ? 0
      : step === 'provider'
        ? 1
        : step === 'workspace'
          ? 2
          : 3; // requirement/preview/manualAgents/done 均归段 4
  return (
    <div className="w-[440px] mb-3 flex items-center gap-1.5 text-[11px] text-tertiary">
      {labels.map((label, i) => (
        <span key={label} className="flex items-center gap-1.5">
          {i > 0 && <span className="w-7 h-px bg-border-strong mx-1" aria-hidden />}
          <span className={i === idx ? 'flex items-center gap-1.5 text-accent-500 font-medium' : ''}>
            <span
              aria-hidden
              className={
                'w-1.5 h-1.5 rounded-full ' + (i === idx ? 'bg-accent-500' : 'bg-border-strong')
              }
            />
            {label}
          </span>
        </span>
      ))}
    </div>
  );
}

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
  const [skipError, setSkipError] = useState<string | null>(null);

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

  // 跳过链（欢迎页与供应商步共用，D1a 提取）：markDone({skipped:true}) 落库 →
  // onFinished 收闩；失败显式呈现错误，向导不关（I2 终审 / spec §9）
  const handleSkip = async (): Promise<void> => {
    try {
      await ipc.onboarding.markDone({ skipped: true });
      onFinished();
    } catch (e) {
      setSkipError(
        `保存引导状态失败（${e instanceof Error ? e.message : String(e)}），请重试`,
      );
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-canvas">
      {/* D11：向导态隐藏新建工作空间「＋」——首屏无空间时它是孤立无语义图标 */}
      <TitleBar wizardMode />
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center p-6">
        <StepAnchorBar step={step} route={route ?? 'ai'} />
        {step === 'welcome' && (
          <>
            <WelcomeStep onSelect={(r) => { setRoute(r); setStep('provider'); }} onSkip={handleSkip} />
            {skipError && (
              <p className="mt-3 text-xs text-status-error" role="alert">
                {skipError}
              </p>
            )}
          </>
        )}
        {step === 'provider' && (
          <>
            <ProviderStep ctx={ctx} onSkip={handleSkip} />
            {skipError && (
              <p className="mt-3 text-xs text-status-error" role="alert">
                {skipError}
              </p>
            )}
          </>
        )}
        {step === 'workspace' && <WorkspaceStep ctx={ctx} />}
        {step === 'requirement' && <RequirementStep ctx={ctx} />}
        {step === 'preview' && <PlanPreviewStep ctx={ctx} />}
        {step === 'manualAgents' && <ManualAgentStep ctx={ctx} />}
        {step === 'done' && <DoneStep ctx={ctx} />}
      </div>
    </div>
  );
}
