// renderer/src/components/agent/AddAgentDialog.tsx
// 添加 agent 对话框：选择已有定义 或 创建自定义 agent + 输入 LLM API key + 提交。
import { useEffect, useState, type FormEvent } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ipc } from '../../ipc/client';

interface Props {
  onClose: () => void;
}

export function AddAgentDialog({ onClose }: Props) {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { definitions, loadDefinitions, addAgent } = useAgentStore();
  const [selectedDefId, setSelectedDefId] = useState<string>('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [mode, setMode] = useState<'select' | 'create'>('select');

  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [newProvider, setNewProvider] = useState('openai');
  const [newModel, setNewModel] = useState('gpt-4o');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void loadDefinitions();
  }, [loadDefinitions]);

  useEffect(() => {
    if (definitions.length > 0 && !selectedDefId) {
      setSelectedDefId(definitions[0]!.id);
    }
  }, [definitions, selectedDefId]);

  const selectedDef = definitions.find((d) => d.id === selectedDefId);
  const providerLabel = selectedDef?.model.provider === 'anthropic' ? 'Anthropic' : 'OpenAI';

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newSlug.trim() || !newPrompt.trim()) {
      setError('名称、标识符和系统提示词不能为空');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const def =       await ipc.agent.createCustom({
        name: newName.trim(),
        slug: newSlug.trim().toLowerCase().replace(/\s+/g, '-'),
        description: `自定义 agent: ${newName.trim()}`,
        systemPrompt: newPrompt.trim(),
        modelProvider: newProvider,
        modelName: newModel.trim(),
        modelBaseUrl: newBaseUrl.trim() || undefined,
        iconEmoji: '🤖',
      });
      await loadDefinitions();
      setSelectedDefId(def.id);
      setMode('select');
      setNewName('');
      setNewSlug('');
      setNewPrompt('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!workspace || !selectedDefId) return;
    if (!apiKey.trim()) {
      setError('API key 不能为空');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await addAgent(workspace.id, selectedDefId, apiKey.trim());
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto">
        {mode === 'create' ? (
          <form onSubmit={handleCreate}>
            <h2 className="text-xl font-bold mb-4">创建自定义 agent</h2>
            <div className="flex flex-col gap-3">
              <Input label="名称" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如：代码审查员" />
              <Input label="标识符 (slug)" value={newSlug} onChange={(e) => setNewSlug(e.target.value)} placeholder="如：code-reviewer" />
              <div className="flex flex-col gap-1">
                <label className="text-sm text-neutral-300">系统提示词</label>
                <textarea
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                  placeholder="你是一名资深代码审查员..."
                  rows={4}
                  className="px-3 py-2 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100 focus:border-accent-blue focus:outline-none resize-y"
                />
              </div>
              <div className="flex gap-3">
                <div className="flex flex-col gap-1 flex-1">
                  <label className="text-sm text-neutral-300">LLM 平台</label>
                  <select
                    value={newProvider}
                    onChange={(e) => setNewProvider(e.target.value)}
                    className="px-3 py-2 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100"
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </div>
                <Input label="模型名" value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder="gpt-4o" />
              </div>
              <Input
                label="Base URL（可选，兼容 OpenAI 格式的第三方供应商）"
                value={newBaseUrl}
                onChange={(e) => setNewBaseUrl(e.target.value)}
                placeholder="留空=官方 API；如 https://open.bigmodel.cn/api/paas/v4"
              />
              {newBaseUrl && (
                <div className="text-xs text-neutral-500">
                  将请求发送到：<code className="text-accent-blue">{newBaseUrl}/v1/chat/completions</code>
                </div>
              )}
              {error && <div className="text-red-400 text-sm">{error}</div>}
              <div className="flex gap-2 justify-end mt-2">
                <Button variant="ghost" type="button" onClick={() => { setMode('select'); setError(null); }}>返回选择</Button>
                <Button type="submit" disabled={creating || !newName || !newSlug || !newPrompt}>
                  {creating ? '创建中…' : '创建'}
                </Button>
              </div>
            </div>
          </form>
        ) : (
          <form onSubmit={handleSubmit}>
            <h2 className="text-xl font-bold mb-4">添加 agent</h2>
            <div className="flex flex-col gap-3">
              {definitions.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-6">
                  <div className="text-4xl">🤖</div>
                  <p className="text-sm text-neutral-400">暂无可用 agent 定义</p>
                  <Button type="button" onClick={() => setMode('create')}>+ 创建自定义 agent</Button>
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-1">
                    <label className="text-sm text-neutral-300">选择 agent</label>
                    <select
                      value={selectedDefId}
                      onChange={(e) => setSelectedDefId(e.target.value)}
                      className="px-3 py-2 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100 focus:border-accent-blue focus:outline-none"
                    >
                      {definitions.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.iconEmoji} {d.name} — {d.description}
                        </option>
                      ))}
                    </select>
                  </div>
                  {selectedDef && (
                    <div className="text-xs text-neutral-500">
                      模型：{selectedDef.model.provider} / {selectedDef.model.model}
                    </div>
                  )}
                  <Input
                    label={`${providerLabel} API key`}
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={selectedDef?.model.provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
                  />
                  <button
                    type="button"
                    onClick={() => setMode('create')}
                    className="text-sm text-accent-blue hover:underline self-start"
                  >
                    + 创建自定义 agent
                  </button>
                </>
              )}

              {error && <div className="text-red-400 text-sm">{error}</div>}
              {definitions.length > 0 && (
                <div className="flex gap-2 justify-end mt-2">
                  <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
                  <Button type="submit" disabled={loading || !selectedDefId || !apiKey}>
                    {loading ? '添加中…' : '添加并启动'}
                  </Button>
                </div>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
