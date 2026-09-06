// renderer/src/components/agent/AddAgentDialog.tsx
//
// 添加已有 Agent 弹窗（Bug 3）：把全局 agent 定义（builtin + custom）加入当前
// 工作空间。后端链路（agent:addMember，同 ws 同 def UNIQUE 防重复）已存在，
// 本弹窗只做「全量列表 − 已加入」的选择 UI。
//
// - 行结构：iconEmoji + 名称 + source 徽标（系统预置/自定义）+ 描述 + 「加入」
// - 加入成功：store.addMember 追加 members → 列表响应式重算，该行消失
// - UNIQUE 竞态兜底：addMember 报错 → 行内 error + loadMembers 重同步
import { useEffect, useMemo, useState } from 'react';
import { Bot } from 'lucide-react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { EmptyState } from '../ui/EmptyState';
import type { AgentDefinition } from '../../ipc/types';

interface Props {
  onClose: () => void;
}

export function AddAgentDialog({ onClose }: Props) {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { definitions, members, loadDefinitions, loadMembers, addMember } = useAgentStore();
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (workspace) {
      // 全量定义（builtin + custom，不带 workspaceId 过滤）
      void loadDefinitions();
      void loadMembers(workspace.id);
    }
  }, [workspace, loadDefinitions, loadMembers]);

  // 已加入当前 ws 的定义集合 → 列表只显示「可添加」项
  const memberDefIds = useMemo(
    () => new Set(members.map((m) => m.agentDefinitionId)),
    [members],
  );
  const addableDefs = definitions.filter((d) => !memberDefIds.has(d.id));

  const handleAdd = async (def: AgentDefinition): Promise<void> => {
    if (!workspace) return;
    setJoiningId(def.id);
    setError(null);
    try {
      await addMember(workspace.id, def.id);
    } catch (err) {
      // UNIQUE 竞态（他处刚加入）→ 重同步成员列表 + 行内提示
      setError((err as Error).message);
      await loadMembers(workspace.id);
    } finally {
      setJoiningId(null);
    }
  };

  return (
    <Dialog open onClose={onClose} title="添加 Agent 到工作空间" width={448}>
      <div className="flex flex-col gap-2">
        {error && (
          <div className="text-status-error text-sm" role="alert">
            {error}
          </div>
        )}

        {addableDefs.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="所有 agent 均已加入本工作空间"
            description="可到「资源库」创建新的 Agent 定义"
          />
        ) : (
          <div className="flex flex-col max-h-96 overflow-y-auto">
            {addableDefs.map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-3"
              >
                <span className="text-lg leading-none">{d.iconEmoji}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-primary truncate">{d.name}</div>
                  <div className="text-xs text-tertiary truncate">{d.description}</div>
                </div>
                <span className="text-xs text-tertiary shrink-0">
                  {d.source === 'builtin' ? '系统预置' : '自定义'}
                </span>
                <Button
                  size="sm"
                  onClick={() => void handleAdd(d)}
                  disabled={joiningId !== null}
                >
                  {joiningId === d.id ? '加入中…' : '加入'}
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
