// renderer/src/components/agent/AssignmentApiKeyEditor.tsx
// 编辑现有 assignment 的 API key override
import { useState, type FormEvent } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import type { WorkspaceAgentMember } from '../../ipc/types';

interface Props {
  assignment: WorkspaceAgentMember;
  onClose: () => void;
}

export function AssignmentApiKeyEditor({ assignment, onClose }: Props) {
  const { definitions, updateMemberApiKey } = useAgentStore();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const def = definitions.find((d) => d.id === assignment.agentDefinitionId);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await updateMemberApiKey(assignment.instanceId, apiKey.trim() || null);
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
        className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-sm"
      >
        <h2 className="text-lg font-bold mb-2">更新 API Key：{def?.iconEmoji} {def?.name}</h2>

        <div className="flex flex-col gap-3">
          {assignment.hasApiKeyOverride && (
            <div className="text-xs text-accent-blue bg-accent-blue/10 rounded p-2">
              ℹ️ 当前使用独立 API key override
            </div>
          )}
          <Input
            label="API Key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="留空使用供应商默认 key"
            autoFocus
          />
          <div className="text-xs text-neutral-500">
            留空清除 override，回退到供应商 key。运行中实例需手动重启生效。
          </div>

          {error && <div className="text-red-400 text-sm">{error}</div>}
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={submitting}>{submitting ? '保存中…' : '保存'}</Button>
          </div>
        </div>
      </form>
    </div>
  );
}
