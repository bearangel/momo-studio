// renderer/src/components/onboarding/PlanPreviewStep.tsx
//
// 占位推进件——Task 8 替换为真实现（方案卡勾选 + 默认单选 + 警告 + 应用）。
import type { WizardCtx } from '../../routes/OnboardingWizard';

export function PlanPreviewStep({ ctx }: { ctx: WizardCtx }) {
  return (
    <div className="w-[400px]">
      <h2 className="text-[15px] font-semibold text-primary">AI 配置方案</h2>
      <p className="text-xs text-tertiary mt-1 mb-4">（Task 8 实现：方案预览与勾改）</p>
      <div className="flex justify-end">
        <button type="button" className="btn-primary" onClick={() => ctx.go('done')}>
          下一步
        </button>
      </div>
    </div>
  );
}
