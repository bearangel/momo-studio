// renderer/src/components/resource-library/wizard/AgentCreateWizard.tsx
//
// 新建智能体 4 步向导（spec §4.1）：基础信息 → System Prompt → 能力绑定 → 模型与完成。
// 提交复用 agent.createCustom（现成支持 defaultMcps/defaultSkills）。
// MembersPanel 的 CreateAgentDialog 保留不动（收敛为后续迭代，spec §11）。
//
// ProviderModelPicker / ThinkingOverrideControl 的 props 形状以
// CreateAgentDialog.tsx 真实用法为准：picker 传 onModelInfo 回传模型行，
// ThinkingOverrideControl 需 capability 入参（能力由 picker 的 onModelInfo 驱动）。
import { useEffect, useState } from 'react';
import { ipc } from '../../../ipc/client';
import type { ReasoningCapability, ResourceItem, ThinkingConfig } from '../../../ipc/types';
import { ALL_BUILTIN_TOOLS, SAFE_MINIMUM_TOOLS, TOOL_CATEGORIES } from '../../../lib/tool-catalog';
import { ProviderModelPicker } from '../../agent/ProviderModelPicker';
import { ThinkingOverrideControl } from '../../agent/ThinkingOverrideControl';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Dialog } from '../../ui/Dialog';
import { cn } from '../../../lib/cn';

type ToolPreset = 'safe' | 'all' | 'custom';

const PRESETS: Array<{ key: ToolPreset; label: string; hint: string }> = [
  { key: 'safe', label: '安全最小集', hint: '读写 / 搜索 / todo，不含 Shell 与 Git 写操作' },
  { key: 'all', label: '全部工具', hint: '全部内置工具（含 bash 与 git 写操作）' },
  { key: 'custom', label: '自选', hint: '手动勾选工具' },
];

const STEPS = ['基础信息', '提示词', '能力', '模型'] as const;

interface Props {
  onClose: () => void;
  onSuccess: () => void;
}

export function AgentCreateWizard({ onClose, onSuccess }: Props) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 步 1：基础信息
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [iconEmoji, setIconEmoji] = useState('🤖');
  // 步 2：System Prompt
  const [prompt, setPrompt] = useState('');
  // 步 3：能力绑定
  const [preset, setPreset] = useState<ToolPreset>('safe');
  const [customTools, setCustomTools] = useState<string[]>([...SAFE_MINIMUM_TOOLS]);
  const [mcps, setMcps] = useState<ResourceItem[]>([]);
  const [skills, setSkills] = useState<ResourceItem[]>([]);
  const [selectedMcps, setSelectedMcps] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  // 步 4：模型与完成
  const [providerId, setProviderId] = useState('');
  const [modelName, setModelName] = useState('');
  const [modelCapability, setModelCapability] = useState<ReasoningCapability | null>(null);
  const [thinkingJson, setThinkingJson] = useState<ThinkingConfig | null>(null);

  // 步 3 挂载时拉能力多选数据（已安装 mcp / skill；失败不阻断创建）
  useEffect(() => {
    if (step !== 2) return;
    let cancelled = false;
    Promise.all([ipc.resource.list({ type: 'mcp' }), ipc.resource.list({ type: 'skill' })])
      .then(([m, s]) => {
        if (cancelled) return;
        setMcps(m.filter((i) => i.installed));
        setSkills(s.filter((i) => i.installed));
      })
      .catch(() => { /* 多选区为空 */ });
    return () => { cancelled = true; };
  }, [step]);

  const validateStep = (): string | null => {
    if (step === 0 && !name.trim()) return '名称不能为空';
    if (step === 1 && !prompt.trim()) return '系统提示词不能为空';
    if (step === 3 && (!providerId || !modelName.trim())) return '请选择模型供应商与模型';
    return null;
  };

  const handleNext = (): void => {
    const err = validateStep();
    if (err) { setError(err); return; }
    setError(null);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const handleSubmit = async (): Promise<void> => {
    const err = validateStep();
    if (err) { setError(err); return; }
    setSaving(true);
    setError(null);
    try {
      const tools =
        preset === 'safe' ? SAFE_MINIMUM_TOOLS : preset === 'all' ? ALL_BUILTIN_TOOLS : customTools;
      await ipc.agent.createCustom({
        name: name.trim(),
        slug: name.trim().toLowerCase().replace(/\s+/g, '-'),
        description: description.trim() || `自定义 agent: ${name.trim()}`,
        systemPrompt: prompt.trim(),
        iconEmoji,
        scope: 'global',
        modelProviderId: providerId,
        modelName: modelName.trim(),
        thinkingJson,
        defaultTools: tools.map((ref) => ({ kind: 'builtin' as const, ref })),
        defaultMcps: selectedMcps.map((ref) => ({ kind: 'mcp' as const, ref })),
        defaultSkills: selectedSkills.map((ref) => ({ kind: 'skill' as const, ref })),
      });
      onSuccess();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (list: string[], setList: (v: string[]) => void, v: string): void =>
    setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Dialog open onClose={onClose} title="新建智能体" width={520}>
      <div className="flex flex-col gap-4">
        {/* 步进条 */}
        <ol className="flex items-center gap-1.5 text-xs">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-1.5">
              <span
                className={cn(
                  'w-5 h-5 rounded-full flex items-center justify-center text-[11px]',
                  i < step
                    ? 'bg-status-success-tint text-status-success'
                    : i === step
                      ? 'bg-accent-500 text-inverse'
                      : 'bg-surface-3 text-tertiary',
                )}
              >
                {i + 1}
              </span>
              <span className={i === step ? 'text-primary font-medium' : 'text-tertiary'}>{label}</span>
              {i < STEPS.length - 1 && <span className="w-4 h-px bg-border-strong" />}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="flex flex-col gap-3">
            <Input label="名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：代码审查员" autoFocus />
            <Input label="描述" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明（可选）" />
            <Input label="图标 emoji" value={iconEmoji} onChange={(e) => setIconEmoji(e.target.value)} placeholder="用户数据照渲染" />
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-1">
            <label htmlFor="wizard-prompt" className="text-sm text-secondary">系统提示词</label>
            <textarea
              id="wizard-prompt"
              aria-label="系统提示词"
              rows={8}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="你是一名资深审查员..."
              className="rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary focus:border-focus focus:outline-none resize-y"
            />
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-4">
            {/* 默认工具集三档（平移自 CreateAgentDialog） */}
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm text-secondary">默认工具集</legend>
              {PRESETS.map((p) => (
                <label key={p.key} className="flex items-start gap-2 text-sm text-secondary">
                  <input
                    type="radio"
                    name="wizard-tool-preset"
                    aria-label={p.label}
                    checked={preset === p.key}
                    onChange={() => setPreset(p.key)}
                    className="mt-0.5"
                  />
                  <span>
                    {p.label}
                    <span className="block text-xs text-tertiary">{p.hint}</span>
                  </span>
                </label>
              ))}
              {preset === 'custom' && (
                <div className="flex flex-col gap-2 pl-5 pt-1">
                  {TOOL_CATEGORIES.map((cat) => (
                    <div key={cat.label}>
                      {/* cat.emoji 为 tool-catalog 数据字段（豁免，非 UI 硬编码图标） */}
                      <div className="text-xs text-tertiary mb-1">{cat.emoji} {cat.label}</div>
                      <div className="flex flex-wrap gap-2">
                        {cat.tools.map((tool) => (
                          <label key={tool} className="flex items-center gap-1 text-xs text-secondary">
                            <input
                              type="checkbox"
                              aria-label={tool}
                              checked={customTools.includes(tool)}
                              onChange={() => toggle(customTools, setCustomTools, tool)}
                            />
                            {tool}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </fieldset>
            {/* MCP / Skill 多选（数据来自资源库已装项） */}
            <div className="flex flex-col gap-2">
              <span className="text-sm text-secondary">绑定 MCP（可选）</span>
              <div className="flex flex-wrap gap-2">
                {mcps.length === 0 && <span className="text-xs text-tertiary">暂无已安装 MCP</span>}
                {mcps.map((m) => (
                  <label key={m.id} className="flex items-center gap-1 text-xs text-secondary">
                    <input
                      type="checkbox"
                      aria-label={m.name}
                      checked={selectedMcps.includes(m.slug)}
                      onChange={() => toggle(selectedMcps, setSelectedMcps, m.slug)}
                    />
                    {m.name}
                  </label>
                ))}
              </div>
              <span className="text-sm text-secondary">绑定 Skill（可选）</span>
              <div className="flex flex-wrap gap-2">
                {skills.length === 0 && <span className="text-xs text-tertiary">暂无已安装 Skill</span>}
                {skills.map((s) => (
                  <label key={s.id} className="flex items-center gap-1 text-xs text-secondary">
                    <input
                      type="checkbox"
                      aria-label={s.name}
                      checked={selectedSkills.includes(s.slug)}
                      onChange={() => toggle(selectedSkills, setSelectedSkills, s.slug)}
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-3">
            <ProviderModelPicker
              providerId={providerId}
              modelId={modelName}
              onProviderChange={setProviderId}
              onModelChange={(id) => {
                setModelName(id);
                setThinkingJson(null); // 换模型重置覆盖，防旧档位残留
              }}
              onModelInfo={(m) => setModelCapability(m?.reasoning ?? null)}
            />
            <ThinkingOverrideControl
              capability={modelCapability}
              value={thinkingJson}
              onChange={setThinkingJson}
            />
            <p className="text-xs text-tertiary">仅创建全局 Agent 定义；加入具体工作空间请从「Agent 管理 → 成员」添加</p>
          </div>
        )}

        {error && <div className="text-status-error text-sm">{error}</div>}

        <div className="flex gap-2 justify-end">
          {step > 0 && (
            <Button variant="ghost" type="button" onClick={() => { setError(null); setStep((s) => Math.max(s - 1, 0)); }}>
              上一步
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button type="button" onClick={handleNext}>下一步</Button>
          ) : (
            <Button type="button" disabled={saving} onClick={() => void handleSubmit()}>
              {saving ? '创建中…' : '创建'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
