// renderer/src/components/onboarding/RequirementStep.tsx
//
// AI 路线需求描述步（spec 2026-10-10 §8 + 预览帧④-A/④变体）：
// textarea（4000 上限计数）→ 生成（loading）→ 成功存方案进 ctx 推进预览；
// 失败错误卡 [重试] [转手动]（保留前序成果，spec §9）。
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { MAX_REQUIREMENT_CHARS } from '../../lib/onboarding-constants';
import { Button } from '../ui/Button';
import type { WizardCtx } from '../../routes/OnboardingWizard';

interface Props {
  ctx: WizardCtx;
}

export function RequirementStep({ ctx }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async (): Promise<void> => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await ipc.onboarding.generatePlan({
        requirement: text.trim().slice(0, MAX_REQUIREMENT_CHARS),
        providerId: ctx.providerId,
        modelId: ctx.modelId,
      });
      ctx.setPlan(r.plan);
      ctx.setPlanWarnings(r.warnings);
      ctx.go('preview');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const shown = text.slice(0, MAX_REQUIREMENT_CHARS);

  return (
    <div className="w-[400px]">
      <h2 className="text-[15px] font-semibold text-primary">描述你的工作需求</h2>
      <p className="text-xs text-tertiary mt-1 mb-4">AI 将据此挑选合适的预制 agent 并完成配置</p>
      <div className="flex flex-col gap-3">
        <textarea
          aria-label="工作需求"
          value={shown}
          onChange={(e) => setText(e.target.value)}
          placeholder="例如：我每周要整理客户访谈记录，提炼需求要点生成需求文档；月末汇总成月度汇报……"
          className="min-h-[120px] w-full resize-y rounded-md border border-border-subtle bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-primary focus:outline-2 focus:outline-accent-500"
        />
        <p className="text-[11px] text-disabled">
          {`已输入 ${shown.length} / ${MAX_REQUIREMENT_CHARS} 字`}
          {text.length > MAX_REQUIREMENT_CHARS && ' · 越界部分提交时自动截断'}
        </p>
        {busy && (
          <div className="flex items-center gap-2 text-[13px] text-tertiary">
            <Loader2 size={16} strokeWidth={1.75} className="animate-spin" />
            AI 正在生成配置方案…通常需要 10–30 秒
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-status-error bg-status-error-tint px-3 py-3">
            <b className="block text-[13px] text-status-error mb-1">{error}</b>
            <span className="text-xs text-secondary leading-relaxed">
              可点击重试，或转手动配置——已完成的模型服务与工作空间不会丢失。
            </span>
            <div className="flex gap-2 mt-2">
              <Button type="button" onClick={() => void generate()} disabled={busy}>
                重试
              </Button>
              <Button type="button" variant="ghost" onClick={ctx.toManual}>
                转手动配置
              </Button>
            </div>
          </div>
        )}
        <div className="flex justify-between">
          <Button type="button" variant="ghost" onClick={() => ctx.go('workspace')}>
            上一步
          </Button>
          <Button type="button" onClick={() => void generate()} disabled={busy || !shown.trim()}>
            {busy ? '生成中…' : '生成配置方案'}
          </Button>
        </div>
      </div>
    </div>
  );
}
