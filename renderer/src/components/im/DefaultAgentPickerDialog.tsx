// renderer/src/components/im/DefaultAgentPickerDialog.tsx
//
// v25 Task 13：默认会话 agent 一次性选择弹窗（spec §7「快速会话无默认 agent」）。
// 快速会话（⚡）发现 ws 无默认 agent 时弹出：单选成员 → setDefaultAgent →
// onContinue(instanceId) 回调继续建快速会话。组件就绪 + 测试归本任务（Task 13）；
// 会话入口接线归 T14。
// ws 无成员 → 引导去 Agent 管理（spec §7 边界：不渲染选择列表）。
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import type { WorkspaceAgentMember } from '../../ipc/types';

interface Props {
  workspaceId: string;
  /** 设默认成功后回调（继续建快速会话）——参数为所选成员 instanceId */
  onContinue: (instanceId: string) => void;
  onClose: () => void;
}

export function DefaultAgentPickerDialog({ workspaceId, onContinue, onClose }: Props) {
  const { members, definitions, loadMembers } = useAgentStore();
  const setDefaultAgent = useWorkspaceStore((s) => s.setDefaultAgent);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadMembers(workspaceId);
  }, [workspaceId, loadMembers]);

  const defMap = useMemo(() => new Map(definitions.map((d) => [d.id, d])), [definitions]);
  const memberLabel = (m: WorkspaceAgentMember): string =>
    defMap.get(m.agentDefinitionId)?.name ?? m.agentName ?? m.agentUserId;

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!selectedId) return;
    setSaving(true);
    setError(null);
    try {
      await setDefaultAgent(workspaceId, selectedId);
      onContinue(selectedId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-md max-h-[85vh] overflow-y-auto"
      >
        <h2 className="text-xl font-bold mb-1">选择默认会话 agent</h2>
        <p className="text-xs text-neutral-500 mb-4">
          快速会话需要一个默认 agent 直达；本次设置后续可随时在「Agent 管理」更换
        </p>

        {members.length === 0 ? (
          <div className="flex flex-col gap-3 py-4 text-center">
            <div className="text-4xl">🤖</div>
            <div className="text-sm text-neutral-300">当前工作空间暂无 agent 成员</div>
            <div className="text-xs text-neutral-500">
              请先到 Agent 管理添加 agent 成员，再使用快速会话
            </div>
            <div className="flex justify-center mt-2">
              <Button variant="ghost" type="button" onClick={onClose}>
                关闭
              </Button>
            </div>
          </div>
        ) : (
          <>
            <fieldset className="flex flex-col gap-1.5">
              {members.map((m) => (
                <label
                  key={m.instanceId}
                  className="flex items-center gap-2 text-sm text-neutral-300 px-2 py-1.5 rounded hover:bg-bg-tertiary/50"
                >
                  <input
                    type="radio"
                    name="default-agent"
                    aria-label={memberLabel(m)}
                    checked={selectedId === m.instanceId}
                    onChange={() => setSelectedId(m.instanceId)}
                  />
                  <span>{defMap.get(m.agentDefinitionId)?.iconEmoji ?? '🤖'}</span>
                  <span>{memberLabel(m)}</span>
                </label>
              ))}
            </fieldset>

            {error && <div className="text-red-400 text-sm mt-2">{error}</div>}
            <div className="flex gap-2 justify-end mt-4">
              <Button variant="ghost" type="button" onClick={onClose}>
                取消
              </Button>
              <Button type="submit" disabled={!selectedId || saving}>
                {saving ? '设置中…' : '设为默认并继续'}
              </Button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
