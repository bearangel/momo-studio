// renderer/src/components/onboarding/WorkspaceStep.tsx
//
// 占位推进件——Task 7 替换为真实现（复用 CreateWorkspaceDialog embedded）。
import type { WizardCtx } from '../../routes/OnboardingWizard';

export function WorkspaceStep({ ctx }: { ctx: WizardCtx }) {
  return (
    <div className="w-[400px]">
      <h2 className="text-[15px] font-semibold text-primary">创建工作空间</h2>
      <p className="text-xs text-tertiary mt-1 mb-4">（Task 7 实现：名称 + 目录 + 浏览按钮）</p>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={() => ctx.go('provider')}>
          上一步
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => ctx.go(ctx.route === 'ai' ? 'requirement' : 'manualAgents')}
        >
          下一步
        </button>
      </div>
    </div>
  );
}
