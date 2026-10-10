// renderer/src/components/onboarding/WorkspaceStep.tsx
//
// 工作空间步（spec 2026-10-10 §8）：复用 CreateWorkspaceDialog embedded
// （名称 + 目录手输 + 原生目录选择器）。创建成功 = store.activeWorkspaceId
// 从 null 翻转为新 id——在此捕获并按路线分叉推进（真实配置是唯一状态源）。
import { useEffect } from 'react';
import { CreateWorkspaceDialog } from '../workspace/CreateWorkspaceDialog';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { WizardCtx } from '../../routes/OnboardingWizard';

interface Props {
  ctx: WizardCtx;
}

export function WorkspaceStep({ ctx }: Props) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    if (!ctx.workspaceId && activeWorkspaceId) {
      ctx.setWorkspace(activeWorkspaceId);
      ctx.go(ctx.route === 'ai' ? 'requirement' : 'manualAgents');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在 ws 翻转时推进一次
  }, [activeWorkspaceId]);

  return (
    <div className="w-[440px]">
      <h2 className="text-[15px] font-semibold text-primary mb-1">创建工作空间</h2>
      <p className="text-xs text-tertiary mb-4">agent 的文件操作都发生在这个目录里</p>
      <CreateWorkspaceDialog onClose={() => undefined} embedded />
    </div>
  );
}
