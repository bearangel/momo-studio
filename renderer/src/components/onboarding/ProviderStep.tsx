// renderer/src/components/onboarding/ProviderStep.tsx
//
// 供应商配置步（spec 2026-10-10 §8 + 预览帧②/②变体）：三形态——
// ① 已有供应商快捷路径（半程重来幂等预填）② 预设 chips（预填可改）
// ③ 自定义供应商手填（对齐 ProviderDialog 语义）。验证走 testConnection
// （先验证后落库——失败零副作用），成功才 create 并推进。
// D1a（预览 S1）：底部左侧加「跳过，稍后在设置中配置」——无 key 用户可跳过
// 本步；markDone/收闩/错误呈现由向导层 handleSkip 拥有（WelcomeStep 同模式）。
import { useEffect, useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { ModelProvider, ProviderPreset, ProviderPlatform, ProviderModel } from '../../ipc/types';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import type { WizardCtx } from '../../routes/OnboardingWizard';

interface Props {
  ctx: WizardCtx;
  /** 跳过本步（D1a）：由向导层注入——markDone({skipped:true}) 后收闩；失败在向导层显错 */
  onSkip?: () => void;
}

export function ProviderStep({ ctx, onSkip }: Props) {
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [mode, setMode] = useState<'chips' | 'existing' | 'preset' | 'custom'>('chips');
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<ProviderPlatform>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState('');
  const [existingId, setExistingId] = useState('');
  const [existingModels, setExistingModels] = useState<ProviderModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void ipc.provider.list().then(setProviders).catch(() => setProviders([]));
    void ipc.provider.listPresets().then(setPresets).catch(() => setPresets([]));
  }, []);

  const choosePreset = (p: ProviderPreset): void => {
    setPreset(p);
    setName(p.name);
    setBaseUrl(p.baseUrl);
    setPlatform(p.platform);
    setModelId(p.models[0]?.id ?? '');
    setMode('preset');
    setError(null);
  };

  const chooseCustom = (): void => {
    setPreset(null);
    setName('');
    setBaseUrl('');
    setModelId('');
    setMode('custom');
    setError(null);
  };

  const chooseExisting = async (p: ModelProvider): Promise<void> => {
    setExistingId(p.id);
    setExistingModels([]);
    try {
      const models = await ipc.provider.listModels(p.id);
      const enabled = models.filter((m) => m.enabled !== false);
      setExistingModels(enabled.length > 0 ? enabled : models);
      setModelId(enabled[0]?.modelId ?? models[0]?.modelId ?? '');
    } catch {
      setExistingModels([]);
      setModelId('');
    }
  };

  const submitExisting = async (): Promise<void> => {
    if (!existingId || !modelId) return;
    try {
      // 验收补修（2026-11-02）：首屏明确选定的模型记为全局默认会话模型
      //（幂等一次，进系统后用户可在设置改）
      await ipc.settings.updateGlobal({
        defaultChatModel: { providerId: existingId, modelId },
      });
      ctx.setProvider(existingId, modelId);
      ctx.go('workspace');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submitNew = async (): Promise<void> => {
    if (!name.trim() || !baseUrl.trim() || !apiKey.trim() || !modelId.trim()) {
      setError('请完整填写名称、Base URL、API Key 与模型');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 先验证后落库——失败零副作用（区别于 ProviderDialog 的可分离测试/保存）
      const r = await ipc.provider.testConnection({ baseUrl, apiKey, model: modelId });
      if (!r.ok) {
        setError(`验证失败：${r.error ?? '未知错误'}——请检查后重试`);
        return;
      }
      const created = await ipc.provider.create({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey,
        platform,
        isDefault: true,
        // 验收补修（2026-11-02）：defaultModel 必须随创建落库（provider_models
        // 行 + default_model 列）——自定义供应商手输模型漏传则进系统后模型服务空
        defaultModel: modelId.trim(),
        ...(preset ? { presetKey: preset.key } : {}),
        // D6（验收报告）：验证刚通过——创建即记为已验证（055 机制，此前漏传
        // 导致设置页永远「未验证」徽标）
        verifiedAtCreation: true,
      });
      await ipc.settings.updateGlobal({
        defaultChatModel: { providerId: created.id, modelId: modelId.trim() },
      });
      ctx.setProvider(created.id, modelId);
      ctx.go('workspace');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-[400px]">
      <h2 className="text-[15px] font-semibold text-primary">配置模型服务</h2>
      <p className="text-xs text-tertiary mt-1 mb-4">选择供应商并填入 API Key，用于驱动你的 agent</p>

      {mode === 'existing' ? (
        <div className="flex flex-col gap-2">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => void chooseExisting(p)}
              className={`rounded-md border px-3 py-2 text-left text-sm ${
                existingId === p.id
                  ? 'border-accent-500 bg-surface-active text-primary'
                  : 'border-border-subtle bg-surface-2 text-secondary hover:bg-surface-3'
              }`}
            >
              {p.name}
            </button>
          ))}
          {existingId && existingModels.length === 0 && (
            <p className="text-xs text-status-warning">
              该供应商暂无模型——请先在设置 → 模型服务拉取模型列表，或新建供应商
            </p>
          )}
          {existingId && existingModels.length > 0 && (
            <Select label="模型" value={modelId} onChange={(e) => setModelId(e.target.value)}>
              {existingModels.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.modelId}
                </option>
              ))}
            </Select>
          )}
          {error && <div className="text-xs text-status-error">{error}</div>}
          <div className="flex justify-between mt-2">
            <Button type="button" variant="ghost" onClick={() => setMode('chips')}>
              返回新建
            </Button>
            <Button type="button" onClick={() => void submitExisting()} disabled={!existingId || !modelId}>
              继续
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {providers.length > 0 && (
            <button
              type="button"
              onClick={() => setMode('existing')}
              className="self-start text-xs text-accent-600 dark:text-accent-300 underline underline-offset-2"
            >
              使用已有供应商
            </button>
          )}
          {mode === 'chips' && (
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => choosePreset(p)}
                  className="rounded-full border border-border-subtle bg-surface-2 px-2.5 py-1 text-xs text-secondary hover:border-accent-500 hover:text-primary"
                >
                  {p.name}
                </button>
              ))}
              <button
                type="button"
                onClick={chooseCustom}
                className="rounded-full border border-border-subtle bg-surface-2 px-2.5 py-1 text-xs text-secondary hover:border-accent-500 hover:text-primary"
              >
                + 自定义供应商
              </button>
            </div>
          )}
          {mode === 'preset' && preset && (
            <>
              {preset.docsUrl && (
                <a
                  href={preset.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-accent-600 dark:text-accent-300"
                >
                  <Link2 size={12} strokeWidth={1.75} aria-hidden /> 获取 API Key（{preset.name} 控制台）
                </a>
              )}
              <Input
                label="API Key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
              />
              <Select label="模型" value={modelId} onChange={(e) => setModelId(e.target.value)}>
                {preset.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </Select>
            </>
          )}
          {mode === 'custom' && (
            <>
              <Input label="名称" value={name} onChange={(e) => setName(e.target.value)} required />
              <Select label="平台" value={platform} onChange={(e) => setPlatform(e.target.value as ProviderPlatform)}>
                <option value="openai">OpenAI 兼容</option>
                <option value="anthropic">Anthropic</option>
              </Select>
              <Input
                label="Base URL"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://llm-gateway.example.com/v1"
                required
              />
              <Input
                label="API Key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
              />
              <Input
                label="模型名"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder="手输模型名，验证连通后即可继续"
                required
              />
            </>
          )}
          {mode !== 'chips' && (
            <p className="text-[11px] text-disabled">Key 仅存系统钥匙串，不会上传 · 验证通过才会创建供应商</p>
          )}
          {error && <div className="text-xs text-status-error">{error}</div>}
          {/* 底部行（预览 S1）：跳过链接居左；主按钮居右。chips 模式无待提交
              动作，仅渲染跳过出口（预览中的禁用态按钮是线稿示意，不设死按钮） */}
          <div className="flex items-center justify-between mt-1">
            <div className="flex items-center gap-3">
              {/* 验收补修（2026-11-02）：chips 形态可回欢迎页重选路线——
                  此前选错服务方向只能跳过整个引导 */}
              {mode === 'chips' && (
                <Button type="button" variant="ghost" onClick={() => ctx.go('welcome')}>
                  上一步
                </Button>
              )}
              {(
                /* 同上：选错预设/误入手填 → 回 chips 重选（existing 已有「返回新建」） */
                <Button type="button" variant="ghost" onClick={() => setMode('chips')}>
                  重新选择
                </Button>
              )}
              {onSkip ? (
                <button
                  type="button"
                  onClick={onSkip}
                  className="text-xs text-accent-600 dark:text-accent-300 underline underline-offset-2"
                >
                  跳过，稍后在设置中配置
                </button>
              ) : (
                <span aria-hidden />
              )}
            </div>
            {mode !== 'chips' && (
              <Button type="button" onClick={() => void submitNew()} disabled={busy}>
                {busy ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 size={13} strokeWidth={1.75} className="animate-spin" /> 验证中…
                  </span>
                ) : (
                  '验证并继续'
                )}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
