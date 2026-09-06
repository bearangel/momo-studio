// renderer/src/components/im/DefaultAgentPickerDialog.tsx
//
// v25 Task 13：默认会话 agent 一次性选择弹窗（spec §7「快速会话无默认 agent」）。
// 快速会话（⚡）发现 ws 无默认 agent 时弹出：单选成员 → setDefaultAgent →
// onContinue(instanceId) 回调继续建快速会话。
// ws 无成员 → 引导去 Agent 管理（spec §7 边界：不渲染选择列表）。
//
// v2.1 P2 Task 15：手写 modal 外壳 → Dialog 原子件；空态 → EmptyState（icon=Bot）；
// iconEmoji 缺省 → Avatar bot（对齐 MentionInput / MembersPanel 先例）。
import { useEffect, useState, type FormEvent } from 'react';
import { Bot } from 'lucide-react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { EmptyState } from '../ui/EmptyState';
import type { WorkspaceAgentMember } from '../../ipc/types';

interface Props {
  workspaceId: string;
  /** 设默认成功后回调（继续建快速会话）——参数为所选成员 instanceId */
  onContinue: (instanceId: string) => void;
  onClose: () => void;
}

export function DefaultAgentPickerDialog({ workspaceId, onContinue, onClose }: Props) {
  const { members, loadMembers } = useAgentStore();
  const setDefaultAgent = useWorkspaceStore((s) => s.setDefaultAgent);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadMembers(workspaceId);
  }, [workspaceId, loadMembers]);

  // v2.2：agentName/iconEmoji 由后端 JOIN definitions 产出，不依赖 definitions 加载时序
  const memberLabel = (m: WorkspaceAgentMember): string => m.agentName;

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
    <Dialog open onClose={onClose} title="选择默认会话 agent" width={448}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <p className="text-xs text-tertiary">
          快速会话需要一个默认 agent 直达；本次设置后续可随时在「Agent 管理」更换
        </p>

        {members.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="当前工作空间暂无 agent 成员"
            description="请先到 Agent 管理添加 agent 成员，再使用快速会话"
            action={
              <div className="flex justify-center mt-2">
                <Button variant="ghost" type="button" onClick={onClose}>
                  关闭
                </Button>
              </div>
            }
          />
        ) : (
          <>
            <fieldset className="flex flex-col gap-1.5">
              {members.map((m) => (
                <label
                  key={m.instanceId}
                  className="flex items-center gap-2 text-sm text-secondary px-2 py-1.5 rounded hover:bg-surface-3"
                >
                  <input
                    type="radio"
                    name="default-agent"
                    aria-label={memberLabel(m)}
                    checked={selectedId === m.instanceId}
                    onChange={() => setSelectedId(m.instanceId)}
                  />
                  <span>
                    {m.iconEmoji || (
                      <Avatar name={memberLabel(m)} bot size="sm" />
                    )}
                  </span>
                  <span>{memberLabel(m)}</span>
                </label>
              ))}
            </fieldset>

            {error && <div className="text-status-error text-sm mt-2">{error}</div>}
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
    </Dialog>
  );
}
