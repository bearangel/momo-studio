// 添加供应商对话框（仅用于创建；编辑在 ProviderSettings 右列配置卡）。
// v2.1 P1：外壳收敛到 Dialog 原子件；表单控件换 Input/Select/Checkbox/Button。
import { useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import type { ModelProvider, ProviderPlatform } from '../../ipc/types';
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
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<ProviderPlatform>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      // model 留空——后端返回「请先填写模型名或在模型服务页拉取模型列表」
      const r = await ipc.provider.testConnection({ baseUrl, apiKey, model: '' });
      setTestResult(
        r.ok ? { ok: true, message: '连接成功' } : { ok: false, message: r.error ?? '连接失败' },
      );
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
      const created = await ipc.provider.create({ name, baseUrl, apiKey, platform, isDefault });
      onSaved(created);
      onClose();
    } catch (err) {
      alert(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <Dialog open onClose={onClose} title="添加供应商" width={420}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <Input
          label="名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Select
          label="平台"
          value={platform}
          onChange={(e) => setPlatform(e.target.value as ProviderPlatform)}
        >
          <option value="openai">OpenAI 兼容</option>
          <option value="anthropic">Anthropic</option>
        </Select>
        <Input
          label="Base URL"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          required
          placeholder="https://open.bigmodel.cn/api/coding/paas/v4"
        />
        <Input
          label="API Key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          required
        />
        <Checkbox
          label="设为默认供应商"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleTest}
            disabled={testing || !apiKey || !baseUrl}
          >
            {testing ? '测试中…' : '测试连接'}
          </Button>
          {testResult && (
            <span className={testResult.ok ? 'text-xs text-secondary' : 'text-xs text-status-error'}>
              {testResult.message}
            </span>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
