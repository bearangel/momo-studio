// renderer/src/components/onboarding/WorkspaceStep.tsx
//
// 工作空间步（spec 2026-10-10 §8）：复用 CreateWorkspaceDialog embedded
// （名称 + 目录手输 + 原生目录选择器）。创建成功 = store.activeWorkspaceId
// 从 null 翻转为新 id——在此捕获并按路线分叉推进（真实配置是唯一状态源）。
import { useEffect } from 'react';
import { Button } from '../ui/Button';
import { CreateWorkspaceDialog } from '../workspace/CreateWorkspaceDialog';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { WizardCtx } from '../../routes/OnboardingWizard';

interface Props {
  ctx: WizardCtx;
}

export function WorkspaceStep({ ctx }: Props) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  // I1（终审）：上一步回退重进时 ctx.workspaceId 已非空——直通路线下一步，
  // 不再依赖 activeWorkspaceId 翻转（恰好落实 spec §3.2「已有 ws 防御性跳过③」）
  useEffect(() => {
    if (ctx.workspaceId) {
      ctx.go(ctx.route === 'ai' ? 'requirement' : 'manualAgents');
      return;
    }
    if (activeWorkspaceId) {
      ctx.setWorkspace(activeWorkspaceId);
      ctx.go(ctx.route === 'ai' ? 'requirement' : 'manualAgents');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在 ws 语义变化时判定一次
  }, [activeWorkspaceId, ctx.workspaceId]);

  return (
    <div className="w-[440px]">
      {/* P3-4（2026-10-15）：h3——embedded 卡片自带 h2「新建工作空间」，双 h2 同层冗余 */}
      <div className="flex justify-start mb-2">
        {/* 验收补修（2026-11-02）：回 provider 重选/改 key——此前本步无返回 */}
        <Button type="button" variant="ghost" onClick={() => ctx.go('provider')}>
          上一步
        </Button>
      </div>
      <h3 className="text-[15px] font-semibold text-primary mb-1">创建工作空间</h3>
      <p className="text-xs text-tertiary mb-4">agent 的文件操作都发生在这个目录里</p>
      <CreateWorkspaceDialog onClose={() => undefined} embedded />
    </div>
  );
}
