// renderer/src/components/onboarding/ProviderStep.tsx
//
// 占位推进件——Task 7 替换为真实现（预设 + 自定义供应商双形态表单）。
import type { WizardCtx } from '../../routes/OnboardingWizard';

export function ProviderStep({ ctx }: { ctx: WizardCtx }) {
  return (
    <div className="w-[400px]">
      <h2 className="text-[15px] font-semibold text-primary">配置模型服务</h2>
      <p className="text-xs text-tertiary mt-1 mb-4">（Task 7 实现：预设 / 自定义供应商表单）</p>
      <div className="flex justify-end">
        <button
          type="button"
          className="btn-primary"
          onClick={() => ctx.go('workspace')}
        >
          下一步
        </button>
      </div>
    </div>
  );
}
