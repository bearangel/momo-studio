// renderer/src/components/agent/AddAgentDialog.tsx
// 添加 agent 对话框：列出可用 agent 定义 + 输入 LLM API key + 提交。
// 提交调用 agent.store.addAgent（→ 主进程 addToWorkspace 一键编排）。
import { useEffect, useState, type FormEvent } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

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

  useEffect(() => {
    void loadDefinitions();
  }, [loadDefinitions]);

  // definitions 加载完成后默认选中第一个
  useEffect(() => {
    if (definitions.length > 0 && !selectedDefId) {
      setSelectedDefId(definitions[0]!.id);
    }
  }, [definitions, selectedDefId]);

  const selectedDef = definitions.find((d) => d.id === selectedDefId);
  const providerLabel =
    selectedDef?.model.provider === 'anthropic' ? 'Anthropic' : 'OpenAI';

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
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-md"
      >
        <h2 className="text-xl font-bold mb-4">添加 agent</h2>
        <div className="flex flex-col gap-3">
          {definitions.length === 0 ? (
            <div className="text-sm text-neutral-500">
              暂无可用 agent 定义（请确认应用已注册内置 agent）。
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
            </>
          )}

          {error && <div className="text-red-400 text-sm">{error}</div>}
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="ghost" type="button" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={loading || !selectedDefId || !apiKey}>
              {loading ? '添加中…' : '添加并启动'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
