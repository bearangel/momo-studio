// renderer/src/components/agent/DefinitionEditor.tsx
// def 创建/编辑/配置 builtin 对话框
import { useEffect, useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useProviderStore } from '../../stores/provider.store';
import { useAgentStore } from '../../stores/agent.store';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import type { AgentDefinition } from '../../ipc/types';

interface Props {
  mode: 'create' | 'edit' | 'configure';
  def?: AgentDefinition;
  onClose: () => void;
}

export function DefinitionEditor({ mode, def, onClose }: Props) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const { providers, loadProviders } = useProviderStore();
  const loadDefinitions = useAgentStore((s) => s.loadDefinitions);

  const isBuiltin = mode === 'configure';
  const readOnly = isBuiltin;

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [prompt, setPrompt] = useState('');
  const [iconEmoji, setIconEmoji] = useState('🤖');
  const [providerId, setProviderId] = useState('');
  const [modelName, setModelName] = useState('');
  const [scope, setScope] = useState<'global' | 'workspace'>('workspace');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { void loadProviders(); }, [loadProviders]);

  useEffect(() => {
    if (def && (mode === 'edit' || mode === 'configure')) {
      setName(def.name);
      setSlug(def.slug);
      setPrompt(def.systemPrompt);
      setIconEmoji(def.iconEmoji);
      setProviderId(def.modelProviderId ?? '');
      setModelName(def.modelName);
      setScope(def.workspaceId === null ? 'global' : 'workspace');
    }
  }, [def, mode]);

  const handleProviderChange = (id: string): void => {
    setProviderId(id);
    const p = providers.find((x) => x.id === id);
    if (p?.defaultModel && !modelName) {
      setModelName(p.defaultModel);
    }
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!name.trim() || !prompt.trim()) {
      setError('名称和系统提示词不能为空');
      return;
    }
    if (!providerId || !modelName.trim()) {
      setError('模型供应商和模型名不能为空');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (mode === 'create') {
        await ipc.agent.createCustom({
          name: name.trim(),
          slug: slug.trim().toLowerCase().replace(/\s+/g, '-'),
          description: `自定义 agent: ${name.trim()}`,
          systemPrompt: prompt.trim(),
          iconEmoji,
          scope,
          modelProviderId: providerId,
          modelName: modelName.trim(),
        });
      } else if (def) {
        const input: Parameters<typeof ipc.agent.updateDefinition>[0] = {
          id: def.id,
          name: name.trim(),
          systemPrompt: prompt.trim(),
          iconEmoji,
          modelProviderId: providerId,
          modelName: modelName.trim(),
        };
        if (!isBuiltin) {
          input.scope = scope;
        }
        await ipc.agent.updateDefinition(input);
      }
      await loadDefinitions(activeWorkspaceId ?? undefined);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const title = mode === 'create' ? '新建 agent 定义' : mode === 'edit' ? '编辑 agent 定义' : '配置 builtin agent';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-md max-h-[85vh] overflow-y-auto"
      >
        <h2 className="text-xl font-bold mb-4">{title}</h2>
        <div className="flex flex-col gap-3">
          <Input
            label="名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：代码审查员"
            readOnly={readOnly}
            autoFocus={mode === 'create'}
          />
          {!isBuiltin && (
            <Input
              label="标识符 (slug)"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="如：code-reviewer"
              readOnly={mode === 'edit'}
            />
          )}
          <div className="flex flex-col gap-1">
            <label className="text-sm text-neutral-300">系统提示词</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="你是一名资深审查员..."
              rows={4}
              readOnly={readOnly}
              className="px-3 py-2 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100 focus:border-accent-blue focus:outline-none resize-y"
            />
          </div>
          <Input
            label="图标 emoji"
            value={iconEmoji}
            onChange={(e) => setIconEmoji(e.target.value)}
            readOnly={readOnly}
          />

          <div className="flex flex-col gap-1">
            <label className="text-sm text-neutral-300">模型供应商 <span className="text-red-400">*</span></label>
            <select
              value={providerId}
              onChange={(e) => handleProviderChange(e.target.value)}
              className="px-3 py-2 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100"
            >
              <option value="">请选择...</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.isDefault ? '（默认）' : ''}
                </option>
              ))}
            </select>
          </div>
          <Input
            label="模型名"
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            placeholder="如 gpt-4o, claude-3-opus"
          />

          {mode === 'create' && (
            <div className="flex flex-col gap-1">
              <label className="text-sm text-neutral-300">范围</label>
              <div className="flex gap-3">
                <label className="flex items-center gap-1 text-sm text-neutral-300">
                  <input type="radio" checked={scope === 'workspace'} onChange={() => setScope('workspace')} />
                  仅本工作空间
                </label>
                <label className="flex items-center gap-1 text-sm text-neutral-300">
                  <input type="radio" checked={scope === 'global'} onChange={() => setScope('global')} />
                  全局共享
                </label>
              </div>
            </div>
          )}

          {error && <div className="text-red-400 text-sm">{error}</div>}
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={saving}>
              {saving ? '保存中…' : (mode === 'create' ? '创建' : '保存')}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
