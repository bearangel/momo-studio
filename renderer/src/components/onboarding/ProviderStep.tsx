// renderer/src/components/onboarding/ProviderStep.tsx
//
// 供应商配置步（spec 2026-10-10 §8 + 预览帧②/②变体）：三形态——
// ① 已有供应商快捷路径（半程重来幂等预填）② 预设 chips（预填可改）
// ③ 自定义供应商手填（对齐 ProviderDialog 语义）。验证走 testConnection
// （先验证后落库——失败零副作用），成功才 create 并推进。
// D1a（预览 S1）：底部左侧加「跳过，稍后在设置中配置」——无 key 用户可跳过
// 本步；markDone/收闩/错误呈现由向导层 handleSkip 拥有（WelcomeStep 同模式）。
import { useEffect, useState } from 'react';
import { Link2, Loader2, RefreshCw } from 'lucide-react';
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

/** preset 形态合并列表（spec 2026-11-13 §3.3）：远端在前 + 预置去重——供应商上新即刻可见、预置永不为空 */
function mergePresetModels(remote: string[], preset: ProviderPreset): string[] {
  return [...remote, ...preset.models.map((m) => m.id)].filter(
    (v, i, a) => a.indexOf(v) === i,
  );
}

/** T1 下拉「手动输入…」哨兵值：选中即回退手输态（spec 2026-11-13 §3.3） */
const MANUAL_OPTION = '__manual__';

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
  // T1 模型列表拉取（spec 2026-11-13 §3.3）：custom 形态字段级状态机
  const [modelFetch, setModelFetch] = useState<{
    status: 'idle' | 'fetching' | 'fetched';
    models: string[];
    truncated: boolean;
  }>({ status: 'idle', models: [], truncated: false });
  const [modelError, setModelError] = useState<string | null>(null);
  // T1 preset「获取最新」：远端列表（null=未拉取，用静态预置）；远端在前与预置去重合并
  const [presetRemote, setPresetRemote] = useState<string[] | null>(null);
  const [busyFetch, setBusyFetch] = useState(false);
  const [existingRefreshing, setExistingRefreshing] = useState(false);

  useEffect(() => {
    void ipc.provider.list().then(setProviders).catch(() => setProviders([]));
    void ipc.provider.listPresets().then(setPresets).catch(() => setPresets([]));
  }, []);

  const resetModelFetch = (): void => {
    setModelFetch({ status: 'idle', models: [], truncated: false });
    setModelError(null);
    setPresetRemote(null);
  };

  const refreshPresetModels = async (): Promise<void> => {
    if (!preset || busyFetch) return;
    setBusyFetch(true);
    setModelError(null);
    try {
      const r = await ipc.provider.probeModels({
        baseUrl: preset.baseUrl,
        apiKey,
        platform: preset.platform,
      });
      setPresetRemote(r.models);
      // 选中项：预置当前值仍在新列表则保留，否则取远端首项（最新优先）
      const merged = mergePresetModels(r.models, preset);
      if (merged.length > 0 && !merged.includes(modelId)) setModelId(merged[0]!);
    } catch (e) {
      setModelError(
        `获取最新失败：${e instanceof Error ? e.message : String(e)}——仍可用预置列表`,
      );
    } finally {
      setBusyFetch(false);
    }
  };

  const fetchCustomModels = async (): Promise<void> => {
    if (modelFetch.status === 'fetching') return;
    setModelFetch({ status: 'fetching', models: [], truncated: false });
    setModelError(null);
    try {
      const r = await ipc.provider.probeModels({
        baseUrl: baseUrl.trim(),
        apiKey,
        platform,
      });
      setModelFetch({ status: 'fetched', models: r.models, truncated: r.truncated });
      // 选中项：原手输值仍在列表则优先保留，否则取首项
      if (r.models.length > 0) {
        setModelId(r.models.includes(modelId) ? modelId : r.models[0]!);
      }
    } catch (e) {
      setModelFetch({ status: 'idle', models: [], truncated: false });
      setModelError(
        `获取失败：${e instanceof Error ? e.message : String(e)}——可手输模型名继续`,
      );
    }
  };

  const choosePreset = (p: ProviderPreset): void => {
    setPreset(p);
    setName(p.name);
    setBaseUrl(p.baseUrl);
    setPlatform(p.platform);
    setModelId(p.models[0]?.id ?? '');
    setMode('preset');
    setError(null);
    resetModelFetch();
  };

  const chooseCustom = (): void => {
    setPreset(null);
    setName('');
    setBaseUrl('');
    setModelId('');
    setMode('custom');
    setError(null);
    resetModelFetch();
  };

  const chooseExisting = async (p: ModelProvider): Promise<void> => {
    setExistingId(p.id);
    await refreshExistingModels(p);
  };

  const refreshExistingModels = async (p: ModelProvider): Promise<void> => {
    setExistingModels([]);
    setExistingRefreshing(true);
    try {
      const models = await ipc.provider.listModels(p.id);
      const enabled = models.filter((m) => m.enabled !== false);
      setExistingModels(enabled.length > 0 ? enabled : models);
      setModelId(enabled[0]?.modelId ?? models[0]?.modelId ?? '');
    } catch {
      setExistingModels([]);
      setModelId('');
    } finally {
      setExistingRefreshing(false);
    }
  };

  /** T1 existing 刷新：fetchModels 落库后重读库内列表（半程重来路径增强） */
  const refreshExistingFromRemote = async (): Promise<void> => {
    if (!existingId || existingRefreshing) return;
    const p = providers.find((x) => x.id === existingId);
    if (!p) return;
    setExistingRefreshing(true);
    try {
      await ipc.provider.fetchModels(existingId);
      await refreshExistingModels(p);
    } catch (e) {
      setModelError(
        `刷新失败：${e instanceof Error ? e.message : String(e)}——仍可用库内列表`,
      );
    } finally {
      setExistingRefreshing(false);
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
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Select label="模型" value={modelId} onChange={(e) => setModelId(e.target.value)}>
                  {existingModels.map((m) => (
                    <option key={m.modelId} value={m.modelId}>
                      {m.modelId}
                    </option>
                  ))}
                </Select>
              </div>
              {/* T1：实时拉远端刷新库内列表（fetchModels 既有通道） */}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void refreshExistingFromRemote()}
                disabled={existingRefreshing}
              >
                {existingRefreshing ? (
                  <Loader2 size={13} strokeWidth={1.75} className="animate-spin" />
                ) : (
                  <RefreshCw size={13} strokeWidth={1.75} aria-hidden />
                )}
                刷新模型
              </Button>
            </div>
          )}
          {modelError && <div className="text-xs text-status-error">{modelError}</div>}
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
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Select label="模型" value={modelId} onChange={(e) => setModelId(e.target.value)}>
                    {(presetRemote ? mergePresetModels(presetRemote, preset) : preset.models.map((m) => m.id)).map(
                      (id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ),
                    )}
                  </Select>
                </div>
                {/* T1：远端实时拉取合并——供应商上新模型即刻可见，预置项永为兜底 */}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void refreshPresetModels()}
                  disabled={busyFetch || !apiKey.trim()}
                >
                  {busyFetch ? (
                    <Loader2 size={13} strokeWidth={1.75} className="animate-spin" />
                  ) : (
                    <RefreshCw size={13} strokeWidth={1.75} aria-hidden />
                  )}
                  获取最新模型
                </Button>
              </div>
              {modelError && <div className="text-xs text-status-error">{modelError}</div>}
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
              {modelFetch.status === 'fetched' ? (
                <Select
                  label="模型名"
                  value={modelId}
                  onChange={(e) => {
                    if (e.target.value === MANUAL_OPTION) {
                      setModelFetch({ status: 'idle', models: [], truncated: false });
                      return;
                    }
                    setModelId(e.target.value);
                  }}
                >
                  {modelFetch.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value={MANUAL_OPTION}>手动输入…</option>
                </Select>
              ) : (
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <Input
                      label="模型名"
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                      placeholder="手输模型名，验证连通后即可继续"
                      required
                    />
                  </div>
                  {/* T1：凭 baseUrl+key 未落库先拉（probeModels 零副作用），帮填不替代验证 */}
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void fetchCustomModels()}
                    disabled={
                      modelFetch.status === 'fetching' || !baseUrl.trim() || !apiKey.trim()
                    }
                  >
                    {modelFetch.status === 'fetching' ? (
                      <Loader2 size={13} strokeWidth={1.75} className="animate-spin" />
                    ) : (
                      <RefreshCw size={13} strokeWidth={1.75} aria-hidden />
                    )}
                    获取模型列表
                  </Button>
                </div>
              )}
              {modelFetch.truncated && (
                <p className="text-[11px] text-status-warning">
                  该供应商模型较多，仅显示前 200 个
                </p>
              )}
              {modelError && <div className="text-xs text-status-error">{modelError}</div>}
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
              {(mode === 'preset' || mode === 'custom') && (
                /* T4：仅子表单出现——chips 空态与「上一步」语义重叠（existing 已有「返回新建」） */
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
