// renderer/src/components/settings/ProviderDialog.tsx
//
// 添加供应商对话框（仅用于创建；编辑在 ProviderSettings 右列配置卡）。
// v31 两段式（spec §7.1）：第一步预设卡片选择（预填 + 种子模型 + 已添加徽标），
// 第二步表单（预填可改，补 API Key）；底部「自定义供应商」保留旧手填路径。
import { useEffect, useState, type FormEvent } from 'react';
import { Link2 } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useProviderStore } from '../../stores/provider.store';
import type { ModelProvider, ProviderPreset, ProviderPlatform } from '../../ipc/types';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Checkbox } from '../ui/Checkbox';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (created: ModelProvider) => void;
}

export function ProviderDialog({ open, onClose, onSaved }: Props) {
  // view：select=预设选择；form=预设表单（预填）；custom=手填（旧路径）
  const [view, setView] = useState<'select' | 'form' | 'custom'>('select');
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<ProviderPlatform>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const providers = useProviderStore((s) => s.providers);
  const loadProviders = useProviderStore((s) => s.loadProviders);

  useEffect(() => {
    if (!open) return;
    setView('select');
    setPreset(null);
    setName(''); setBaseUrl(''); setApiKey(''); setIsDefault(false);
    setTestResult(null);
    void loadProviders();
    ipc.provider.listPresets().then(setPresets).catch(() => setPresets([]));
  }, [open, loadProviders]);

  const choosePreset = (p: ProviderPreset): void => {
    setPreset(p);
    setName(p.name);
    setBaseUrl(p.baseUrl);
    setPlatform(p.platform);
    setView('form');
  };

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await ipc.provider.testConnection({ baseUrl, apiKey, model: '' });
      setTestResult(r.ok ? { ok: true, message: '连接成功' } : { ok: false, message: r.error ?? '连接失败' });
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    try {
      const created = await ipc.provider.create({
        name, baseUrl, apiKey, platform, isDefault,
        ...(view === 'form' && preset ? { presetKey: preset.key } : {}),
      });
      onSaved(created);
      onClose();
    } catch (err) {
      alert(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  // ── 第一步：预设选择 ──────────────────────────────────────────────────────
  if (view === 'select') {
    return (
      <Dialog open onClose={onClose} title="添加供应商" width={520}>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2" data-testid="preset-grid">
            {presets.map((p) => {
              const added = providers.some((x) => x.presetKey === p.key);
              return (
                <button key={p.key} type="button" onClick={() => choosePreset(p)}
                  className="flex flex-col items-start gap-1 rounded border border-subtle bg-surface-2 px-3 py-2 text-left hover:bg-surface-3">
                  <span className="flex w-full items-center justify-between gap-1">
                    <span className="text-sm text-primary">{p.name}</span>
                    {added && (
                      <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-secondary">已添加</span>
                    )}
                  </span>
                  <span className="text-xs text-tertiary">
                    {p.fetchListHint ? '创建后可拉取模型列表' : `预置 ${p.models.length} 个常用模型`}
                  </span>
                </button>
              );
            })}
          </div>
          <Button type="button" variant="ghost" onClick={() => { setPreset(null); setView('custom'); }}>
            自定义供应商
          </Button>
        </div>
      </Dialog>
    );
  }

  // ── 第二步：表单（预设预填可改 / 自定义手填） ──────────────────────────────
  return (
    <Dialog open onClose={() => setView('select')} title={view === 'form' ? `添加 ${preset?.name ?? ''}` : '添加供应商'} width={420}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {view === 'form' && preset?.docsUrl && (
          <a href={preset.docsUrl} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-accent-600 dark:text-accent-300">
            <Link2 size={12} strokeWidth={1.75} aria-hidden /> 获取 API Key（{preset.name} 控制台）
          </a>
        )}
        <Input label="名称" value={name} onChange={(e) => setName(e.target.value)} required />
        <Select label="平台" value={platform} onChange={(e) => setPlatform(e.target.value as ProviderPlatform)}>
          <option value="openai">OpenAI 兼容</option>
          <option value="anthropic">Anthropic</option>
        </Select>
        <Input label="Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required
          placeholder="https://open.bigmodel.cn/api/paas/v4" />
        <Input label="API Key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
        <Checkbox label="设为默认供应商" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={handleTest} disabled={testing || !apiKey || !baseUrl}>
            {testing ? '测试中…' : '测试连接'}
          </Button>
          {testResult && (
            <span className={testResult.ok ? 'text-xs text-secondary' : 'text-xs text-status-error'}>
              {testResult.message}
            </span>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setView('select')}>返回</Button>
          <Button type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
