// renderer/src/components/agent/AssignmentRoleEditor.tsx
// 编辑现有 assignment 的 role + parent
import { useState, useEffect, type FormEvent } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { Button } from '../ui/Button';
import type { AgentAssignment, AgentRole } from '../../ipc/types';

interface Props {
  assignment: AgentAssignment;
  onClose: () => void;
}

export function AssignmentRoleEditor({ assignment, onClose }: Props) {
  const { assignments, definitions, updateAssignmentRole } = useAgentStore();
  const [role, setRole] = useState<AgentRole>(assignment.role);
  const [parentInstanceId, setParentInstanceId] = useState(assignment.parentInstanceId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const def = definitions.find((d) => d.id === assignment.agentDefinitionId);
  const mainAssignments = assignments.filter(
    (a) => a.role === 'main' && a.instanceId !== assignment.instanceId,
  );

  // 从 main 改为非 main 时有 subs 警告
  const subsOfMe = assignment.role === 'main'
    ? assignments.filter((a) => a.parentInstanceId === assignment.instanceId)
    : [];

  useEffect(() => {
    setRole(assignment.role);
    setParentInstanceId(assignment.parentInstanceId ?? '');
  }, [assignment]);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await updateAssignmentRole(
        assignment.instanceId,
        role,
        role === 'sub' ? parentInstanceId : undefined,
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
        className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-sm"
      >
        <h2 className="text-lg font-bold mb-2">编辑角色：{def?.iconEmoji} {def?.name}</h2>
        <p className="text-xs text-neutral-500 mb-4">
          当前：{assignment.role === 'main' ? '主 agent' : assignment.role === 'sub' ? `子 agent (parent: ${parentInstanceId || '无'})` : '独立'}
        </p>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-sm text-neutral-300">新角色</label>
            <div className="flex gap-3">
              {(['standalone', 'main', 'sub'] as const).map((r) => (
                <label key={r} className="flex items-center gap-1 text-sm text-neutral-300">
                  <input type="radio" checked={role === r} onChange={() => setRole(r)} />
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
                  const d = definitions.find((x) => x.id === a.agentDefinitionId);
                  return (
                    <option key={a.instanceId} value={a.instanceId}>
                      {d?.iconEmoji ?? '🤖'} {d?.name ?? '未知'}
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {subsOfMe.length > 0 && role !== 'main' && (
            <div className="text-xs text-amber-500 bg-amber-500/10 rounded p-2">
              ⚠️ 当前有 {subsOfMe.length} 个子 agent 挂在此 agent 下。改为非主角色后，子 agent 将停止并需要重新配置。
            </div>
          )}

          <div className="text-xs text-neutral-500">
            ⚠️ 应用新角色需要停止并重启该 agent 实例
          </div>

          {error && <div className="text-red-400 text-sm">{error}</div>}
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={submitting || (role === 'sub' && !parentInstanceId)}>
              {submitting ? '应用中…' : '应用并重启'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
