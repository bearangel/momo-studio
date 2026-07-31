// renderer/src/components/agent/AddAgentDialog.tsx
// 添加 agent 对话框：选择已有定义 或 创建自定义 agent + 输入 LLM API key + 提交。
import { useEffect, useState, type FormEvent } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useProviderStore } from '../../stores/provider.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ipc } from '../../ipc/client';
import type { AgentDefinition } from '../../ipc/types';

interface Props {
  onClose: () => void;
  /** 编辑模式：传入则预填并走 updateDefinition；缺省=创建模式 */
  editingDef?: AgentDefinition | null;
}

export function AddAgentDialog({ onClose, editingDef }: Props) {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { definitions, loadDefinitions, addAgent, assignMainAgent } = useAgentStore();
  const [selectedDefId, setSelectedDefId] = useState<string>('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [mode, setMode] = useState<'select' | 'create' | 'edit'>(editingDef ? 'edit' : 'select');

  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [newProvider, setNewProvider] = useState('openai');
  const [newModel, setNewModel] = useState('gpt-4o');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  const [creating, setCreating] = useState(false);
  // 角色：standalone（独立）/ main（主，可调度子）/ sub（挂在某 main 下）
  const [newType, setNewType] = useState<'standalone' | 'main' | 'sub'>('standalone');
  // sub 角色时的父主 agent ID
  const [newParentId, setNewParentId] = useState<string>('');
  // 选中 main 定义时，要随主 agent 一起安装的子 agent 集合
  const [selectedSubIds, setSelectedSubIds] = useState<Set<string>>(new Set());

  // 供应商下拉：选已注册供应商自动填充 baseUrl/model/apiKey，"自定义…"走手动输入
  const { providers, loadProviders } = useProviderStore();
  const [providerId, setProviderId] = useState<string>('custom');

  // 编辑模式：用传入 definition 预填全部字段（slug 仅展示，提交时不可改）
  useEffect(() => {
    if (editingDef && mode === 'edit') {
      setNewName(editingDef.name);
      setNewSlug(editingDef.slug);
      setNewPrompt(editingDef.systemPrompt);
      setNewProvider(editingDef.model.provider);
      setNewModel(editingDef.model.model);
      setNewBaseUrl(editingDef.model.baseUrl ?? '');
      setProviderId('custom');
      setNewType(editingDef.type as 'standalone' | 'main' | 'sub');
      setNewParentId(editingDef.parentAgentId ?? '');
    }
  }, [editingDef, mode]);

  useEffect(() => {
    void loadDefinitions();
  }, [loadDefinitions]);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    if (definitions.length > 0 && !selectedDefId) {
      setSelectedDefId(definitions[0]!.id);
    }
  }, [definitions, selectedDefId]);

  const selectedDef = definitions.find((d) => d.id === selectedDefId);
  const providerLabel = selectedDef?.model.provider === 'anthropic' ? 'Anthropic' : 'OpenAI';

  // 选中 main 定义时，默认勾选全部子 agent；非 main 清空
  useEffect(() => {
    if (selectedDef?.type === 'main') {
      const subIds = definitions
        .filter((d) => d.parentAgentId === selectedDef.id)
        .map((d) => d.id);
      setSelectedSubIds(new Set(subIds));
    } else {
      setSelectedSubIds(new Set());
    }
  }, [selectedDefId, definitions, selectedDef]);

  // 所有 main 定义（供创建 sub 时选择父 agent、以及子角色下拉禁用判断）
  const mainDefs = definitions.filter((d) => d.type === 'main');
  // 当前选中 main 定义下的全部子 agent（供勾选区渲染）
  const subDefsOfSelected = selectedDef?.type === 'main'
    ? definitions.filter((d) => d.parentAgentId === selectedDef.id)
    : [];

  // 选择供应商：填 baseUrl+modelName（defaultModel），并预填 apiKey 供后续"添加并启动"复用
  const handleProviderChange = async (id: string) => {
    setProviderId(id);
    if (id === 'custom') return;
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    setNewBaseUrl(p.baseUrl);
    setNewModel(p.defaultModel ?? '');
    const key = await ipc.provider.getApiKey(p.id);
    if (key) setApiKey(key);
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newSlug.trim() || !newPrompt.trim()) {
      setError('名称、标识符和系统提示词不能为空');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      if (mode === 'edit' && editingDef) {
        const { stoppedInstanceIds } = await ipc.agent.updateDefinition({
          id: editingDef.id,
          name: newName.trim(),
          description: `自定义 agent: ${newName.trim()}`,
          systemPrompt: newPrompt.trim(),
          modelProvider: newProvider,
          modelName: newModel.trim(),
          modelBaseUrl: newBaseUrl.trim() || undefined,
          iconEmoji: editingDef.iconEmoji || '🤖',
          type: newType,
          parentAgentId: newType === 'sub' ? newParentId : undefined,
        });
        await loadDefinitions();
        if (stoppedInstanceIds.length > 0) {
          alert(`Agent 配置已更新。${stoppedInstanceIds.length} 个运行中的实例已停止，请点击启动以应用新配置。`);
        }
        onClose();
        return;
      }
      const def = await ipc.agent.createCustom({
        name: newName.trim(),
        slug: newSlug.trim().toLowerCase().replace(/\s+/g, '-'),
        description: `自定义 agent: ${newName.trim()}`,
        systemPrompt: newPrompt.trim(),
        modelProvider: newProvider,
        modelName: newModel.trim(),
        modelBaseUrl: newBaseUrl.trim() || undefined,
        iconEmoji: '🤖',
        type: newType,
        parentAgentId: newType === 'sub' ? newParentId : undefined,
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
      if (selectedDef?.type === 'main') {
        // main 定义走 assignMain（一次性安装 main + 选中的 subs）
        await assignMainAgent(
          workspace.id,
          selectedDefId,
          apiKey.trim(),
          Array.from(selectedSubIds),
        );
      } else {
        await addAgent(workspace.id, selectedDefId, apiKey.trim());
      }
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
        {mode !== 'select' ? (
          <form onSubmit={handleCreate}>
            <h2 className="text-xl font-bold mb-4">{mode === 'edit' ? '编辑 agent' : '创建自定义 agent'}</h2>
            <div className="flex flex-col gap-3">
              <Input label="名称" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如：代码审查员" />
              <Input label="标识符 (slug)" value={newSlug} onChange={(e) => setNewSlug(e.target.value)} placeholder="如：code-reviewer" readOnly={mode === 'edit'} />
              {/* 角色选择：决定该 agent 在主子调度中的位置 */}
              <div className="flex flex-col gap-1">
                <label className="text-sm text-neutral-300">角色</label>
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value as 'standalone' | 'main' | 'sub')}
                  className="px-3 py-2 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100"
                >
                  <option value="standalone">独立 agent</option>
                  <option value="main">主 agent（可调度子 agent）</option>
                  <option value="sub" disabled={mainDefs.length === 0}>
                    子 agent{mainDefs.length === 0 ? '（需先创建主 agent）' : ''}
                  </option>
                </select>
              </div>
              {/* 子角色：选择父主 agent */}
              {newType === 'sub' && (
                <div className="flex flex-col gap-1">
                  <label className="text-sm text-neutral-300">父主 agent</label>
                  <select
                    value={newParentId}
                    onChange={(e) => setNewParentId(e.target.value)}
                    className="px-3 py-2 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100"
                  >
                    <option value="">选择...</option>
                    {mainDefs.map((m) => (
                      <option key={m.id} value={m.id}>{m.iconEmoji} {m.name}</option>
                    ))}
                  </select>
                </div>
              )}
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
              <div className="flex flex-col gap-1">
                <label className="text-sm text-neutral-300">供应商</label>
                <select
                  value={providerId}
                  onChange={(e) => void handleProviderChange(e.target.value)}
                  className="px-3 py-2 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100 focus:border-accent-blue focus:outline-none"
                >
                  <option value="custom">自定义…</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}{p.isDefault ? '（默认）' : ''}
                    </option>
                  ))}
                </select>
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
                {mode === 'edit' ? (
                  <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
                ) : (
                  <Button variant="ghost" type="button" onClick={() => { setMode('select'); setError(null); }}>返回选择</Button>
                )}
                <Button type="submit" disabled={creating || !newName || !newSlug || !newPrompt}>
                  {creating ? (mode === 'edit' ? '保存中…' : '创建中…') : (mode === 'edit' ? '保存' : '创建')}
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
                  {/* main 定义：展示子 agent 勾选区，随主 agent 一起安装 */}
                  {selectedDef?.type === 'main' && subDefsOfSelected.length > 0 && (
                    <div className="flex flex-col gap-2 p-3 rounded-md bg-bg-tertiary border border-border-subtle">
                      <div className="text-sm text-neutral-300">子 Agent（随主 agent 一起安装）</div>
                      {subDefsOfSelected.map((sub) => (
                        <label key={sub.id} className="flex items-center gap-2 text-sm text-neutral-200">
                          <input
                            type="checkbox"
                            checked={selectedSubIds.has(sub.id)}
                            onChange={(e) => {
                              const next = new Set(selectedSubIds);
                              if (e.target.checked) next.add(sub.id);
                              else next.delete(sub.id);
                              setSelectedSubIds(next);
                            }}
                          />
                          {sub.iconEmoji} {sub.name}
                        </label>
                      ))}
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
                    {loading
                      ? '安装中…'
                      : selectedDef?.type === 'main' ? '安装主 agent' : '添加并启动'}
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
