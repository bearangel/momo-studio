// 添加供应商对话框（P2 Task 6 起仅用于创建；编辑移入 ProviderSettings 右列配置卡）：
// 名称/平台/BaseURL/APIKey/设为默认 + 测试连接。defaultModel 字段已移除——由模型列表取代。
//
// P3 Task 2：测试连接不再硬编码 model='gpt-3.5-turbo'。新建供应商时 model 列表尚未存在，
// 直接传 model=''，由后端 testConnection 兜底返回「请先填写模型名或在模型服务页拉取模型列表」。
import { useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import type { ModelProvider, ProviderPlatform } from '../../ipc/types';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (created: ModelProvider) => void;
}

export function ProviderDialog({ open, onClose, onSaved }: Props) {
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<ProviderPlatform>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      // P3 Task 2：model 留空——后端会返回「请先填写模型名或在模型服务页拉取模型列表」。
      const r = await ipc.provider.testConnection({ baseUrl, apiKey, model: '' });
      setTestResult(r.ok ? '✅ 连接成功' : `❌ ${r.error}`);
    } catch (e) {
      setTestResult(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    try {
      const created = await ipc.provider.create({ name, baseUrl, apiKey, platform, isDefault });
      onSaved(created);
      onClose();
    } catch (err) {
      alert(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="添加供应商"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="bg-bg-secondary border border-border-subtle rounded-lg p-6 w-[420px] flex flex-col gap-3"
      >
        <h3 className="text-neutral-100 text-base">添加供应商</h3>
        <label className="text-xs text-neutral-400">名称
          <input value={name} onChange={(e) => setName(e.target.value)} required
            className="mt-1 w-full bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-sm text-neutral-100" />
        </label>
        <label className="text-xs text-neutral-400">平台
          <select value={platform} onChange={(e) => setPlatform(e.target.value as ProviderPlatform)}
            className="mt-1 w-full bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-sm text-neutral-100">
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
        <label className="text-xs text-neutral-400">Base URL
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required placeholder="https://open.bigmodel.cn/api/coding/paas/v4"
            className="mt-1 w-full bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-sm text-neutral-100" />
        </label>
        <label className="text-xs text-neutral-400">API Key
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required
            className="mt-1 w-full bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-sm text-neutral-100" />
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-300">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          设为默认供应商
        </label>
        <div className="flex items-center gap-2">
          <button type="button" onClick={handleTest} disabled={testing || !apiKey || !baseUrl}
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
