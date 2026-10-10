// renderer/src/components/onboarding/ManualAgentStep.tsx
//
// 手动路线配置步（spec 2026-10-10 §8 + 预览帧⑤）：预制清单勾选（可展开
// previewBuiltinPreset 详情）+ 自定义折叠表单（名称/提示词/工具两档）+
// 默认 agent 单选 → 组装 OnboardingPlan 复用 applyPlan 应用器（与 AI 路线
// 终点等价）。手动路线不暴露 MCP/skill 勾选（spec §8；预制 def 的 YAML
// 声明能力在启用链保留）。
import { useEffect, useMemo, useState } from 'react';
import { ipc } from '../../ipc/client';
import type { BuiltinPresetItem, BuiltinPresetPreview, OnboardingPlanAgent } from '../../ipc/types';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Input } from '../ui/Input';
import type { WizardCtx } from '../../routes/OnboardingWizard';

interface Props {
  ctx: WizardCtx;
}

const PROMPT_PREVIEW_LIMIT = 200;

export function ManualAgentStep({ ctx }: Props) {
  const [presets, setPresets] = useState<BuiltinPresetItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<BuiltinPresetPreview | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [toolPreset, setToolPreset] = useState<'standard' | 'all'>('standard');
  const [defaultKey, setDefaultKey] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void ipc.resource.listBuiltinPresets('agent').then(setPresets).catch(() => setPresets([]));
  }, []);

  const customValid = customOpen && customName.trim() !== '' && customPrompt.trim() !== '';
  const canFinish = selected.size > 0 || customValid;

  const entries = useMemo<Array<{ key: string; agent: OnboardingPlanAgent; label: string }>>(() => {
    const list: Array<{ key: string; agent: OnboardingPlanAgent; label: string }> = [
      ...selected,
    ].map((slug) => {
      const p = presets.find((x) => x.slug === slug);
      return {
        key: `preset:${slug}`,
        agent: { kind: 'preset' as const, slug, reason: '', mcps: [], skills: [] },
        label: p?.name ?? slug,
      };
    });
    if (customValid) {
      list.push({
        key: 'custom:0',
        agent: {
          kind: 'custom' as const,
          name: customName.trim(),
          iconEmoji: '🤖',
          systemPrompt: customPrompt.trim(),
          toolPreset,
          reason: '',
          mcps: [],
          skills: [],
        },
        label: customName.trim(),
      });
    }
    return list;
  }, [selected, presets, customValid, customName, customPrompt, toolPreset]);

  const effectiveDefaultKey = entries.some((e) => e.key === defaultKey)
    ? defaultKey
    : (entries[0]?.key ?? '');

  const togglePreset = (slug: string, on: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(slug);
      else next.delete(slug);
      return next;
    });
  };

  const apply = async (): Promise<void> => {
    if (!canFinish || busy) return;
    setBusy(true);
    setError(null);
    try {
      const agents = entries.map((e) => e.agent);
      const defaultAgentIndex = Math.max(
        entries.findIndex((e) => e.key === effectiveDefaultKey),
        0,
      );
      const result = await ipc.onboarding.applyPlan({
        plan: { agents, defaultAgentIndex },
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
    <div className="w-[450px]">
      <h2 className="text-[15px] font-semibold text-primary">选择你的 agent</h2>
      <p className="text-xs text-tertiary mt-1 mb-3">勾选预制 agent 启用；都不合适可创建自定义</p>
      <div className="flex flex-col gap-2">
        {presets.map((p) => (
          <div key={p.slug} className="rounded-lg border border-border-subtle bg-surface-1 p-3 flex gap-2.5">
            <Checkbox
              aria-label={`启用 ${p.name}`}
              checked={selected.has(p.slug)}
              onChange={(e) => togglePreset(p.slug, e.target.checked)}
            />
            <div className="flex-1">
              <div className="flex items-center gap-1.5 mb-0.5">
                <b className="text-[13px] text-primary">{p.name}</b>
                <span className="rounded-full bg-status-violet-tint px-1.5 py-px text-[10px] font-semibold text-status-violet">
                  预制
                </span>
              </div>
              <p className="text-[11.5px] text-secondary leading-relaxed">{p.description}</p>
              <div className="mt-1 flex items-center gap-3">
                <button
                  type="button"
                  className="text-[11px] text-accent-600 dark:text-accent-300 underline underline-offset-2"
                  onClick={() => {
                    if (preview?.slug === p.slug) {
                      setPreview(null);
                      return;
                    }
                    setPreview(null);
                    void ipc.resource
                      .previewBuiltinPreset(p.slug)
                      .then(setPreview)
                      .catch(() => setPreview(null));
                  }}
                >
                  详情
                </button>
                {selected.has(p.slug) && (
                  <label className="flex items-center gap-1.5 text-xs text-secondary">
                    <input
                      type="radio"
                      name="manual-default-agent"
                      checked={effectiveDefaultKey === `preset:${p.slug}`}
                      onChange={() => setDefaultKey(`preset:${p.slug}`)}
                    />
                    默认会话 agent
                  </label>
                )}
              </div>
              {preview?.slug === p.slug && (
                <div className="mt-2 rounded-md bg-surface-2 p-2 text-[11px] leading-relaxed text-secondary">
                  <b className="text-primary">系统提示词（截断）：</b>
                  {preview.systemPrompt.slice(0, PROMPT_PREVIEW_LIMIT)}
                  {preview.systemPrompt.length > PROMPT_PREVIEW_LIMIT && '…'}
                  {preview.tools.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {preview.tools.slice(0, 8).map((t) => (
                        <span key={t} className="rounded bg-surface-3 px-1.5 py-px text-[10px] text-tertiary">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <details className="mt-3 rounded-lg border border-dashed border-border-strong p-3" open={customOpen}>
        <summary
          className="cursor-pointer text-xs text-accent-600 dark:text-accent-300"
          onClick={(e) => {
            e.preventDefault();
            setCustomOpen((v) => !v);
          }}
        >
          + 创建自定义 agent（名称 / 提示词 / 工具档）
        </summary>
        {customOpen && (
          <div className="mt-2 flex flex-col gap-2">
            <Input label="名称" value={customName} onChange={(e) => setCustomName(e.target.value)} />
            <div className="flex flex-col gap-1">
              <label className="text-sm text-secondary">系统提示词</label>
              <textarea
                aria-label="系统提示词"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                className="min-h-[64px] w-full resize-y rounded-md border border-border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary focus:outline-2 focus:outline-accent-500"
              />
            </div>
            <div className="flex gap-1.5">
              {(
                [
                  { v: 'standard', label: '标准工具（安全最小集）' },
                  { v: 'all', label: '全部工具' },
                ] as const
              ).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setToolPreset(o.v)}
                  className={`rounded-full px-2.5 py-1 text-xs ${
                    toolPreset === o.v
                      ? 'border border-accent-500 bg-surface-active font-semibold text-accent-600 dark:text-accent-300'
                      : 'border border-border-subtle bg-surface-2 text-secondary'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {customValid && (
              <label className="flex items-center gap-1.5 text-xs text-secondary">
                <input
                  type="radio"
                  name="manual-default-agent"
                  checked={effectiveDefaultKey === 'custom:0'}
                  onChange={() => setDefaultKey('custom:0')}
                />
                默认会话 agent：{customName.trim()}
              </label>
            )}
          </div>
        )}
      </details>

      {error && (
        <div className="mt-3 rounded-lg border border-status-error bg-status-error-tint px-3 py-3">
          <b className="block text-[13px] text-status-error mb-1">{error}</b>
          <div className="flex gap-2 mt-2">
            <Button type="button" onClick={() => void apply()} disabled={busy}>
              重试
            </Button>
          </div>
        </div>
      )}

      <div className="flex justify-end mt-3">
        <Button type="button" onClick={() => void apply()} disabled={busy || !canFinish}>
          {busy ? '应用中…' : '完成配置'}
        </Button>
      </div>
    </div>
  );
}
