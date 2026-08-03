// renderer/src/components/agent/AddToWorkspaceDialog.tsx
// 选 def + role + parent + apiKeyOverride → 添加到当前 workspace
import { useState, useEffect, type FormEvent } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { getProviderName } from '../../lib/provider-helpers';
import type { AgentDefinition, AgentRole } from '../../ipc/types';

interface Props {
  preselectedDef?: AgentDefinition;
  onClose: () => void;
}

export function AddToWorkspaceDialog({ preselectedDef, onClose }: Props) {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { definitions, assignments, builtinSuggestions, addAgent } = useAgentStore();

  const [defId, setDefId] = useState(preselectedDef?.id ?? '');
  const [role, setRole] = useState<AgentRole>('standalone');
  const [parentInstanceId, setParentInstanceId] = useState('');
  const [apiKeyOverride, setApiKeyOverride] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 选中 def 时预填建议 role
  useEffect(() => {
    if (defId && builtinSuggestions[defId]) {
      setRole(builtinSuggestions[defId]!.role);
    }
  }, [defId, builtinSuggestions]);

  const selectedDef = definitions.find((d) => d.id === defId);
  const mainAssignments = assignments.filter((a) => a.role === 'main');
  const unconfigured = selectedDef && !selectedDef.modelProviderId;

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!workspace || !defId) return;
    if (role === 'sub' && !parentInstanceId) {
      setError('子 agent 必须选择父主 agent');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await addAgent(
        workspace.id,
        defId,
        role,
        role === 'sub' ? parentInstanceId : undefined,
        apiKeyOverride.trim() || undefined,
      );
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-md"
      >
        <h2 className="text-xl font-bold mb-4">添加 agent 到本工作空间</h2>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-sm text-neutral-300">选择 agent</label>
            <select
              value={defId}
              onChange={(e) => setDefId(e.target.value)}
              className="px-3 py-2 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100"
            >
              <option value="">请选择...</option>
              {definitions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.iconEmoji} {d.name} — {getProviderName(d.modelProviderId)} · {d.modelName}
                </option>
              ))}
            </select>
          </div>

          {unconfigured && (
            <div className="text-xs text-amber-500 bg-amber-500/10 rounded p-2">
              ⚠️ 该 agent 未配置模型供应商，无法启动。请先到 Agent 库配置。
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-sm text-neutral-300">角色</label>
            <div className="flex gap-3">
              {(['standalone', 'main', 'sub'] as const).map((r) => (
                <label key={r} className="flex items-center gap-1 text-sm text-neutral-300">
                  <input
                    type="radio"
                    checked={role === r}
                    onChange={() => setRole(r)}
                  />
                  {r === 'standalone' ? '独立' : r === 'main' ? '主 agent' : '子 agent'}
                </label>
              ))}
            </div>
          </div>

          {role === 'sub' && (
            <div className="flex flex-col gap-1">
              <label className="text-sm text-neutral-300">父主 agent</label>
              <select
                value={parentInstanceId}
                onChange={(e) => setParentInstanceId(e.target.value)}
                className="px-3 py-2 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100"
              >
                <option value="">请选择...</option>
                {mainAssignments.map((a) => {
                  const def = definitions.find((d) => d.id === a.agentDefinitionId);
                  return (
                    <option key={a.instanceId} value={a.instanceId}>
                      {def?.iconEmoji ?? '🤖'} {def?.name ?? '未知'}
                    </option>
                  );
                })}
              </select>
              {mainAssignments.length === 0 && (
                <span className="text-xs text-neutral-500">当前工作空间暂无主 agent。请先添加一个主 agent。</span>
              )}
            </div>
          )}

          <Input
            label="API Key（可选）"
            type="password"
            value={apiKeyOverride}
            onChange={(e) => setApiKeyOverride(e.target.value)}
            placeholder="留空使用供应商默认 key"
          />

          {error && <div className="text-red-400 text-sm">{error}</div>}
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={submitting || !defId || !!unconfigured || (role === 'sub' && !parentInstanceId)}>
              {submitting ? '添加中…' : '添加并启动'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
