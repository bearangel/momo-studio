// renderer/src/components/onboarding/DoneStep.tsx
//
// 占位推进件——Task 9 替换为真实现（配置摘要 + 开始使用 + markDone）。
import type { WizardCtx } from '../../routes/OnboardingWizard';

export function DoneStep({ ctx }: { ctx: WizardCtx }) {
  return (
    <div className="w-[400px] text-center">
      <h2 className="text-[16px] font-semibold text-primary">一切就绪</h2>
      <p className="text-xs text-tertiary mt-1 mb-4">（Task 9 实现：配置摘要）</p>
      <button type="button" className="btn-primary w-full" onClick={ctx.finish}>
        开始使用
      </button>
    </div>
  );
}
