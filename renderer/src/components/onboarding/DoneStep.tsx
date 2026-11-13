// renderer/src/components/onboarding/DoneStep.tsx
//
// 完成页（spec 2026-10-10 §8 + 预览帧⑥）：配置摘要（applyResult 缺省兜底）
// + 开始使用 → markDone({skipped:false}) → finish（App 重拉 → MainShell）。
import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useSessionStore } from '../../stores/session.store';
import { Button } from '../ui/Button';
import { showToast } from '../ui/Toast';
import type { WizardCtx } from '../../routes/OnboardingWizard';

interface Props {
  ctx: WizardCtx;
}

export function DoneStep({ ctx }: Props) {
  const r = ctx.applyResult;
  const agentNames = r ? r.applied.map((a) => a.name).join(' · ') : '';
  const [error, setError] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    // I2（终审）：markDone 失败显式呈现，向导不关（spec §9）——且不建会话
    try {
      await ipc.onboarding.markDone({ skipped: false });
    } catch (e) {
      setError(`保存引导状态失败（${e instanceof Error ? e.message : String(e)}），请重试`);
      return;
    }
    // T3（spec 2026-11-13 §5）：终点直通——默认 agent 快速会话即开即用
    //（与主界面「快速会话」按钮同源链路）；失败降级 toast，不阻断进入主界面
    const ok = await useSessionStore.getState().createQuickSession(ctx.workspaceId);
    if (!ok) showToast('快速会话创建失败，可稍后在会话列表手动新建');
    ctx.finish();
  };

  return (
    <div className="w-[400px] text-center">
      <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-status-success-tint">
        <CheckCircle2 size={22} strokeWidth={1.75} className="text-status-success" />
      </span>
      <h2 className="text-base font-semibold text-primary">一切就绪</h2>
      <p className="text-xs text-tertiary mt-1 mb-3.5">你的 agent 已配置完成，可以开始工作了</p>
      <div className="mb-3.5 rounded-lg border border-border-subtle bg-surface-1 p-3 text-left">
        {r ? (
          <>
            <div className="flex justify-between border-b border-border-subtle py-1.5 text-xs text-secondary">
              <b className="font-medium text-primary">启用的 agent</b>
              <span>{agentNames}</span>
            </div>
            <div className="flex justify-between border-b border-border-subtle py-1.5 text-xs text-secondary">
              <b className="font-medium text-primary">默认会话智能体</b>
              <span>{r.defaultAgentName}</span>
            </div>
            {r.team && (
              <div className="flex justify-between border-b border-border-subtle py-1.5 text-xs text-secondary">
                <b className="font-medium text-primary">已组建团队</b>
                <span>
                  {r.team.name} · 队长 {r.team.leaderName}
                </span>
              </div>
            )}
            {r.warnings.length > 0 && (
              <div className="py-1.5 text-xs text-status-warning">{r.warnings.join('；')}</div>
            )}
          </>
        ) : (
          <div className="py-1.5 text-xs text-secondary">配置已应用</div>
        )}
      </div>
      {error && (
        <p className="mt-2 text-xs text-status-error" role="alert">
          {error}
        </p>
      )}
      <Button type="button" className="w-full" onClick={() => void start()}>
        开始使用
      </Button>
    </div>
  );
}
