// 添加/编辑供应商对话框：名称/baseUrl/apiKey/默认模型/设为默认 + 测试连接
import { useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import type { ModelProvider } from '../../ipc/types';

interface Props {
  open: boolean;
  editing?: ModelProvider | null;
  onClose: () => void;
  onSaved: () => void;
}

export function ProviderDialog({ open, editing, onClose, onSaved }: Props) {
  const [name, setName] = useState(editing?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState(editing?.defaultModel ?? '');
  const [isDefault, setIsDefault] = useState(editing?.isDefault ?? false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await ipc.provider.testConnection({ baseUrl, apiKey, model: defaultModel || 'gpt-3.5-turbo' });
      setTestResult(r.ok ? '✅ 连接成功' : `❌ ${r.error}`);
    } catch (e) {
      setTestResult(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        await ipc.provider.update({
          id: editing.id, name, baseUrl,
          apiKey: apiKey || undefined, // 空则不改
          defaultModel: defaultModel || undefined, isDefault,
        });
      } else {
        await ipc.provider.create({ name, baseUrl, apiKey, defaultModel: defaultModel || undefined, isDefault });
      }
      onSaved();
      onClose();
    } catch (err) {
      alert(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="bg-bg-secondary border border-border-subtle rounded-lg p-6 w-[420px] flex flex-col gap-3"
      >
        <h3 className="text-neutral-100 text-base">{editing ? '编辑供应商' : '添加供应商'}</h3>
        <label className="text-xs text-neutral-400">名称
          <input value={name} onChange={(e) => setName(e.target.value)} required
            className="mt-1 w-full bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-sm text-neutral-100" />
        </label>
        <label className="text-xs text-neutral-400">Base URL
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required placeholder="https://open.bigmodel.cn/api/coding/paas/v4"
            className="mt-1 w-full bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-sm text-neutral-100" />
        </label>
        <label className="text-xs text-neutral-400">API Key{editing ? '（留空不修改）' : ''}
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required={!editing}
            className="mt-1 w-full bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-sm text-neutral-100" />
        </label>
        <label className="text-xs text-neutral-400">默认模型（可选）
          <input value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)}
            className="mt-1 w-full bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-sm text-neutral-100" />
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-300">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          设为默认供应商
        </label>
        <div className="flex items-center gap-2">
          <button type="button" onClick={handleTest} disabled={testing || !apiKey}
            className="text-xs px-2 py-1 rounded border border-border-subtle text-neutral-300 hover:bg-bg-tertiary disabled:opacity-50">
            {testing ? '测试中…' : '测试连接'}
          </button>
          {testResult && <span className="text-xs">{testResult}</span>}
        </div>
        <div className="flex justify-end gap-2 mt-2">
          <button type="button" onClick={onClose} className="text-xs px-3 py-1 text-neutral-400 hover:text-neutral-200">取消</button>
          <button type="submit" disabled={saving} className="text-xs px-3 py-1 rounded bg-accent-blue text-white disabled:opacity-50">
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
