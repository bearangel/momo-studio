// 供应商注册表 UI（P2 Task 6 两列重构，照 settings.html「模型服务」原型）：
// 左列 218px 供应商列表（名称 + 模型数徽标 + 默认 Star 标记 + Plus 创建入口）；
// 右列配置卡（名称/平台下拉/BaseURL/APIKey 留空不改/检查连接/保存）+ ProviderModelList 模型管理。
// defaultModel 字段已从 UI 移除（类型保留 deprecated，agent 定义快捷填充仍读旧列）。
// v2.1 P1：token 化 + emoji 清零 + 测试结果结构化状态（cn 驱动状态色）。
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Star, Plus } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { cn } from '../../lib/cn';
import { useProviderStore } from '../../stores/provider.store';
import { ProviderDialog } from './ProviderDialog';
import { ProviderModelList } from './ProviderModelList';
import type { ModelProvider, ProviderPlatform } from '../../ipc/types';

export function ProviderSettings() {
  const { providers, loading, loadProviders, deleteProvider, setDefault } = useProviderStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modelCounts, setModelCounts] = useState<Record<string, number>>({});

  const refreshCounts = useCallback(async (): Promise<void> => {
    const list = useProviderStore.getState().providers;
    const entries = await Promise.all(
      list.map(async (p) => [p.id, (await ipc.provider.listModels(p.id)).length] as const),
    );
    setModelCounts(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    void (async () => {
      await loadProviders();
      await refreshCounts();
    })();
  }, [loadProviders, refreshCounts]);

  // 加载完成后自动选中默认（或首个）供应商，右列直接可编辑
  useEffect(() => {
    if (selectedId || providers.length === 0) return;
    const first = providers.find((p) => p.isDefault) ?? providers[0];
    if (first) setSelectedId(first.id);
  }, [providers, selectedId]);

  const selected = providers.find((p) => p.id === selectedId) ?? null;

  const handleCreated = async (created: ModelProvider): Promise<void> => {
    await loadProviders();
    await refreshCounts();
    setSelectedId(created.id);
  };

  const handleDeleted = async (target: ModelProvider): Promise<void> => {
    await deleteProvider(target.id);
    setSelectedId(null);
    await refreshCounts();
  };

  const handleSetDefault = async (target: ModelProvider): Promise<void> => {
    await setDefault(target.id);
    await loadProviders();
  };

  return (
    <div className="flex gap-4 items-stretch">
      <aside style={{ width: '218px' }} className="shrink-0 flex flex-col rounded-lg border border-subtle bg-surface-1 overflow-hidden self-start">
        <div className="flex items-center justify-between px-3 py-2 border-b border-subtle">
          <span className="text-xs text-secondary">{loading ? '加载中…' : `供应商（${providers.length}）`}</span>
          <button type="button" onClick={() => setDialogOpen(true)} aria-label="添加供应商" title="添加供应商"
            className="flex items-center justify-center text-xs px-1.5 rounded border border-subtle text-secondary hover:bg-surface-3">
            <Plus size={12} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-1.5 flex flex-col gap-1">
          {!loading && providers.length === 0 && (
            <p className="text-xs text-tertiary px-1.5 py-1">暂无供应商。点击右上角「＋」创建（如 GLM / DeepSeek / OpenAI）。</p>
          )}
          {providers.map((p) => (
            <button key={p.id} type="button" onClick={() => setSelectedId(p.id)}
              className={cn('text-left text-sm px-2 py-1.5 rounded flex items-center gap-1.5 min-w-0',
                selectedId === p.id ? 'bg-surface-active text-accent-600 dark:text-accent-300' : 'text-secondary hover:bg-surface-3')}>
              {p.isDefault && (
                <span title="默认供应商" className="shrink-0 text-accent-500">
                  <Star size={12} strokeWidth={1.75} aria-hidden fill="currentColor" />
                </span>
              )}
              <span className="truncate flex-1">{p.name}</span>
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-secondary" title="模型数">
                {modelCounts[p.id] ?? 0}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {selected ? (
          <>
            <ProviderConfigCard
              key={selected.id}
              provider={selected}
              onSaved={() => void loadProviders()}
              onDeleted={() => void handleDeleted(selected)}
              onSetDefault={() => void handleSetDefault(selected)}
            />
            <ProviderModelList providerId={selected.id} onChanged={() => void refreshCounts()} />
          </>
        ) : (
          <div className="border border-dashed border-subtle rounded-lg p-8 text-sm text-tertiary flex items-center justify-center">
            从左侧选择一个供应商查看配置，或点击「＋」添加。
          </div>
        )}
      </div>

      <ProviderDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={(created) => void handleCreated(created)}
      />
    </div>
  );
}

/** 右列配置卡：编辑选中供应商的名称/平台/BaseURL/APIKey（留空不改） */
function ProviderConfigCard({ provider, onSaved, onDeleted, onSetDefault }: {
  provider: ModelProvider;
  onSaved: () => void;
  onDeleted: () => void;
  onSetDefault: () => void;
}) {
  const { updateProvider } = useProviderStore();
  const [name, setName] = useState(provider.name);
  const [platform, setPlatform] = useState<ProviderPlatform>(provider.platform);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      // apiKey 留空 = 不修改：测试连接回退到 keychain 已存密钥
      const key = apiKey || (await ipc.provider.getApiKey(provider.id)) || '';
      const models = await ipc.provider.listModels(provider.id);
      const model = models.find((m) => m.enabled)?.modelId ?? '';
      const r = await ipc.provider.testConnection({ baseUrl, apiKey: key, model });
      setTestResult(r.ok ? { ok: true, text: '连接成功' } : { ok: false, text: r.error ?? '连接失败' });
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    try {
      await updateProvider({
        id: provider.id, name, baseUrl, platform,
        ...(apiKey ? { apiKey } : {}),
      });
      onSaved();
    } catch (err) {
      alert(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (): void => {
    if (!confirm(`确定删除供应商「${provider.name}」？\n已使用该供应商的 agent 不受影响（持有副本）。`)) return;
    onDeleted();
  };

  return (
    <div className="rounded-lg border border-subtle bg-surface-1 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm text-primary">供应商配置</h3>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onSetDefault} disabled={provider.isDefault}
            className="inline-flex items-center gap-1 text-xs text-secondary hover:text-primary disabled:opacity-40">
            <Star size={12} strokeWidth={1.75} aria-hidden /> 设为默认
          </button>
          <button type="button" onClick={handleDelete}
            className="text-xs text-status-error hover:text-status-error">删除</button>
        </div>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <label className="text-xs text-secondary">名称
          <input value={name} onChange={(e) => setName(e.target.value)} required
            className="mt-1 w-full rounded border border-subtle bg-surface-2 px-2 py-1 text-sm text-primary" />
        </label>
        <label className="text-xs text-secondary">平台
          <select value={platform} onChange={(e) => setPlatform(e.target.value as ProviderPlatform)}
            className="mt-1 w-full rounded border border-subtle bg-surface-2 px-2 py-1 text-sm text-primary">
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
        <label className="text-xs text-secondary">Base URL
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required placeholder="https://open.bigmodel.cn/api/coding/paas/v4"
            className="mt-1 w-full rounded border border-subtle bg-surface-2 px-2 py-1 text-sm text-primary" />
        </label>
        <label className="text-xs text-secondary">API Key（留空不修改）
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="••••••••"
            className="mt-1 w-full rounded border border-subtle bg-surface-2 px-2 py-1 text-sm text-primary" />
        </label>
        <div className="flex items-center gap-3">
          <button type="button" onClick={handleTest} disabled={testing}
            className="text-xs px-2 py-1 rounded border border-subtle text-secondary hover:bg-surface-3 disabled:opacity-50">
            {testing ? '检查中…' : '检查连接'}
          </button>
          {testResult && (
            <span className={cn('text-xs', testResult.ok ? 'text-status-success' : 'text-status-error')}>
              {testResult.text}
            </span>
          )}
          <span className="flex-1" />
          <button type="submit" disabled={saving}
            className="text-xs px-3 py-1 rounded bg-accent-500 text-inverse disabled:opacity-50">
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
