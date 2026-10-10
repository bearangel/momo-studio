// renderer/src/components/onboarding/PlanPreviewStep.tsx
//
// AI 路线方案预览步（spec 2026-10-10 §8 + 预览帧④-B）：
// 方案卡勾改 + 默认 agent 单选（随勾选收缩回退）+ 生成侧警告区 +
// 应用（幂等重试）/ 失败转手动。
import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import type { WizardCtx } from '../../routes/OnboardingWizard';
import type { OnboardingPlanAgent } from '../../ipc/types';

interface Props {
  ctx: WizardCtx;
}

/** 卡片展示名：preset 用 slug 映射名（previewBuiltinPreset 同源不可得时兜底 slug） */
function agentLabel(a: OnboardingPlanAgent): string {
  return a.kind === 'custom' ? a.name : presetName(a.slug);
}

const PRESET_NAMES: Record<string, string> = {
  coder: '程序员',
  'pm-agent': '项目经理',
  'requirement-analyst': '需求分析师',
  'office-assistant': '办公助理',
  'ui-designer': 'UI 设计师',
  'code-reviewer': '代码审查员',
  'general-assistant': '通用助理',
  researcher: '调研员',
};

function presetName(slug: string): string {
  return PRESET_NAMES[slug] ?? slug;
}

export function PlanPreviewStep({ ctx }: Props) {
  const plan = ctx.plan;
  const [checked, setChecked] = useState<boolean[]>(() => plan?.agents.map(() => true) ?? []);
  const [defaultIdx, setDefaultIdx] = useState<number>(() =>
    plan ? Math.min(Math.max(plan.defaultAgentIndex, 0), plan.agents.length - 1) : 0,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkedCount = useMemo(() => checked.filter(Boolean).length, [checked]);
  const effectiveDefault = useMemo(() => {
    if (checked[defaultIdx]) return defaultIdx;
    const first = checked.indexOf(true);
    return first;
  }, [checked, defaultIdx]);

  if (!plan || plan.agents.length === 0) {
    return (
      <div className="w-[460px]">
        <h2 className="text-[15px] font-semibold text-primary">AI 配置方案</h2>
        <p className="text-xs text-tertiary mt-1 mb-4">暂无方案——请返回需求描述重新生成</p>
        <Button type="button" onClick={() => ctx.go('requirement')}>
          返回需求描述
        </Button>
      </div>
    );
  }

  const apply = async (): Promise<void> => {
    if (checkedCount === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const agents = plan.agents.filter((_, i) => checked[i]);
      const relIdx = effectiveDefault < 0 ? 0 : checked.slice(0, effectiveDefault).filter(Boolean).length;
      const result = await ipc.onboarding.applyPlan({
        plan: { agents, defaultAgentIndex: Math.max(relIdx, 0) },
        workspaceId: ctx.workspaceId,
        providerId: ctx.providerId,
        modelId: ctx.modelId,
      });
      ctx.setApplyResult(result);
      ctx.go('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-[460px]">
      <h2 className="text-[15px] font-semibold text-primary">AI 配置方案</h2>
      <p className="text-xs text-tertiary mt-1 mb-3">确认后应用 · 取消勾选可剔除不需要的 agent</p>
      <div className="flex flex-col gap-2">
        {plan.agents.map((agent, i) => (
          <div
            key={i}
            className={`flex gap-2.5 rounded-lg border border-border-subtle bg-surface-1 p-3 ${
              checked[i] ? '' : 'opacity-50'
            }`}
          >
            <Checkbox
              aria-label={`启用 ${agentLabel(agent)}`}
              checked={checked[i] ?? false}
              onChange={(e) =>
                setChecked((prev) => prev.map((c, j) => (j === i ? e.target.checked : c)))
              }
            />
            <div className="flex-1">
              <div className="flex items-center gap-1.5 mb-0.5">
                <b className="text-[13px] text-primary">{agentLabel(agent)}</b>
                {agent.kind === 'preset' ? (
                  <span className="rounded-full bg-status-violet-tint px-1.5 py-px text-[10px] font-semibold text-status-violet">
                    预制
                  </span>
                ) : (
                  <span className="rounded-full bg-surface-active px-1.5 py-px text-[10px] font-semibold text-accent-600 dark:text-accent-300">
                    自定义
                  </span>
                )}
              </div>
              <p className="text-[11.5px] leading-relaxed text-secondary mb-1.5">{agent.reason}</p>
              {(agent.mcps.length > 0 || agent.skills.length > 0) && (
                <div className="flex flex-wrap gap-1">
                  {agent.mcps.map((m) => (
                    <span key={m} className="rounded bg-surface-3 px-1.5 py-px text-[10px] text-tertiary">
                      MCP · {m}
                    </span>
                  ))}
                  {agent.skills.map((s) => (
                    <span key={s} className="rounded bg-surface-3 px-1.5 py-px text-[10px] text-tertiary">
                      Skill · {s}
                    </span>
                  ))}
                </div>
              )}
              {checked[i] && (
                <label className="mt-1.5 flex items-center gap-1.5 text-xs text-secondary">
                  <input
                    type="radio"
                    name="default-agent"
                    checked={effectiveDefault === i}
                    onChange={() => setDefaultIdx(i)}
                  />
                  默认会话 agent
                </label>
              )}
            </div>
          </div>
        ))}
      </div>
      {ctx.planWarnings.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          {ctx.planWarnings.map((w, i) => (
            <div
              key={i}
              className="flex items-start gap-1.5 rounded-md bg-status-warning-tint px-2 py-1.5 text-[11px] text-status-warning"
            >
              <AlertTriangle size={13} strokeWidth={1.75} className="mt-px shrink-0" />
              {w}
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-lg border border-status-error bg-status-error-tint px-3 py-3">
          <b className="block text-[13px] text-status-error mb-1">{error}</b>
          <span className="text-xs text-secondary leading-relaxed">
            已应用的配置会保留——可整包重试（幂等），或转手动继续。
          </span>
          <div className="flex gap-2 mt-2">
            <Button type="button" onClick={() => void apply()} disabled={busy}>
              重试
            </Button>
            <Button type="button" variant="ghost" onClick={ctx.toManual}>
              转手动配置
            </Button>
          </div>
        </div>
      )}
      <div className="flex justify-between items-center mt-3">
        <span className="text-xs text-secondary">
          {effectiveDefault >= 0 && (
            <>默认会话 agent：{agentLabel(plan.agents[effectiveDefault]!)}（快速会话直达）</>
          )}
        </span>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={() => ctx.go('requirement')}>
            重新生成
          </Button>
          <Button type="button" onClick={() => void apply()} disabled={busy || checkedCount === 0}>
            {busy ? '应用中…' : '应用配置'}
          </Button>
        </div>
      </div>
    </div>
  );
}
