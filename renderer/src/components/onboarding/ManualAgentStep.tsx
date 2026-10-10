// renderer/src/components/onboarding/ManualAgentStep.tsx
//
// 占位推进件——Task 9 替换为真实现（预制清单勾选 + 自定义折叠表单 + 默认单选）。
import type { WizardCtx } from '../../routes/OnboardingWizard';

export function ManualAgentStep({ ctx }: { ctx: WizardCtx }) {
  return (
    <div className="w-[400px]">
      <h2 className="text-[15px] font-semibold text-primary">选择你的 agent</h2>
      <p className="text-xs text-tertiary mt-1 mb-4">（Task 9 实现：预制清单 + 自定义表单）</p>
      <div className="flex justify-end">
        <button type="button" className="btn-primary" onClick={() => ctx.go('done')}>
          下一步
        </button>
      </div>
    </div>
  );
}
