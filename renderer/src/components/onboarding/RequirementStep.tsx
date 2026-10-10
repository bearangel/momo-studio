// renderer/src/components/onboarding/RequirementStep.tsx
//
// 占位推进件——Task 8 替换为真实现（需求 textarea + 生成 loading + 失败卡）。
import type { WizardCtx } from '../../routes/OnboardingWizard';

export function RequirementStep({ ctx }: { ctx: WizardCtx }) {
  return (
    <div className="w-[400px]">
      <h2 className="text-[15px] font-semibold text-primary">描述你的工作需求</h2>
      <p className="text-xs text-tertiary mt-1 mb-4">（Task 8 实现：textarea + 生成方案）</p>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={() => ctx.go('workspace')}>
          上一步
        </button>
        <button type="button" className="btn-primary" onClick={() => ctx.go('preview')}>
          下一步
        </button>
      </div>
    </div>
  );
}
