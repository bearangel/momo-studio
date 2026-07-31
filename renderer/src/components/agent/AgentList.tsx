// renderer/src/components/agent/AgentList.tsx
// 当前 workspace 内已分配的 agent 列表 + "添加 agent" 按钮 + 选中后的能力配置详情面板。
// 每个 agent 显示名称、状态徽章（运行中/已停止）、停止按钮；点击展开能力配置。
import { useEffect, useState } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { ipc } from '../../ipc/client';
import type { AgentDefinition } from '../../ipc/types';
import { AddAgentDialog } from './AddAgentDialog';
import { CapabilityConfig } from './CapabilityConfig';
import { PromptDialog } from '../common/PromptDialog';
import { cn } from '../../lib/cn';

interface Props {
  onAdd: () => void;
}

export function AgentList({ onAdd }: Props) {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const setCoordinator = useWorkspaceStore((s) => s.setCoordinator);
  const { assignments, definitions, running, loading, loadDefinitions, loadAssignments } =
    useAgentStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingDef, setEditingDef] = useState<AgentDefinition | null>(null);
  const [keyPrompt, setKeyPrompt] = useState<string | null>(null);

  useEffect(() => {
    void loadDefinitions();
  }, [loadDefinitions]);

  useEffect(() => {
    if (workspace) void loadAssignments(workspace.id);
  }, [workspace, loadAssignments]);

  // 按 definitionId 反查 agent 定义（取名称/图标/默认能力）
  const defMap = new Map(definitions.map((d) => [d.id, d]));
  const selected = assignments.find((a) => a.instanceId === selectedId) ?? null;
  const selectedDef = selected ? defMap.get(selected.agentDefinitionId) : undefined;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <h2 className="text-sm font-semibold text-neutral-200">Agents</h2>
        <Button size="sm" onClick={onAdd} disabled={!workspace}>
          + 添加 agent
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {loading && assignments.length === 0 ? (
          <div className="text-center text-neutral-500 text-sm py-8">加载中…</div>
        ) : assignments.length === 0 ? (
          <div className="text-center text-neutral-500 text-sm py-8">
            <div className="text-3xl mb-2">🤖</div>
            <p>还没有 agent。点击右上角"添加 agent"开始。</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {assignments.map((a) => {
              const def = defMap.get(a.agentDefinitionId);
              const isRunning = running[a.instanceId] === true;
              const isSelected = selectedId === a.instanceId;
              return (
                <li
                  key={a.instanceId}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 rounded-lg bg-bg-tertiary border cursor-pointer',
                    isSelected ? 'border-accent-blue' : 'border-border-subtle',
                  )}
                  onClick={() => setSelectedId(isSelected ? null : a.instanceId)}
                >
                  <span className="text-xl">{def?.iconEmoji ?? '🤖'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-neutral-100 flex items-center gap-1.5 min-w-0">
                      <span className="truncate">{def?.name ?? a.agentDefinitionId}</span>
                      {workspace?.coordinatorInstanceId === a.instanceId && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 shrink-0">
                          协调
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-neutral-500 truncate">{a.botMatrixUserId}</div>
                  </div>
                  <span
                    className={
                      'text-xs px-2 py-0.5 rounded-full ' +
                      (isRunning
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-neutral-500/20 text-neutral-400')
                    }
                  >
                    {isRunning ? '运行中' : '已停止'}
                  </span>
                  {isRunning && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        void useAgentStore.getState().stopAgent(a.instanceId);
                      }}
                    >
                      停止
                    </Button>
                  )}
                  {!isRunning && workspace && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        void ipc.agent
                          .start({
                            assignment: a,
                            workspaceId: workspace.id,
                            teamRoomId: workspace.teamRoomId,
                          })
                          .then(() => loadAssignments(workspace.id))
                          .catch((err) =>
                            alert(`启动失败：${err instanceof Error ? err.message : String(err)}`),
                          );
                      }}
                    >
                      启动
                    </Button>
                  )}
                  {workspace && workspace.coordinatorInstanceId === a.instanceId ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void setCoordinator(workspace.id, null);
                      }}
                      className="text-xs text-amber-400 hover:text-amber-300"
                    >
                      取消协调
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!workspace}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!workspace) return;
                        void setCoordinator(workspace.id, a.instanceId).then(() =>
                          alert('已设为协调 agent。若该实例正在运行，请停止后重新启动以生效。'),
                        );
                      }}
                      className="text-xs text-neutral-400 hover:text-amber-400 disabled:opacity-40"
                    >
                      ⭐ 设为协调
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingDef(def ?? null);
                    }}
                    className="text-xs text-neutral-400 hover:text-neutral-200"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setKeyPrompt(a.instanceId);
                    }}
                    className="text-xs text-neutral-400 hover:text-neutral-200"
                  >
                    更新密钥
                  </button>
                  <button
                    type="button"
                    title="删除 agent"
                    className="text-neutral-500 hover:text-red-400 text-sm px-1"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`确定删除 agent「${def?.name ?? '未知'}」？\n将停止运行 + 移除分配记录。`)) {
                        void useAgentStore.getState().stopAgent(a.instanceId);
                        void ipc.agent.removeAssignment(a.instanceId).then(() => {
                          void loadAssignments(workspace?.id ?? '');
                        });
                      }
                    }}
                  >
                    🗑
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {workspace && selected && (
        <div className="border-t border-border-subtle p-4 max-h-[45%] overflow-auto bg-bg-secondary">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm text-neutral-200">
              {selectedDef?.iconEmoji ?? '🤖'} {selectedDef?.name ?? 'agent'} · 能力
            </div>
            <button
              type="button"
              className="text-xs text-neutral-500 hover:text-neutral-300"
              onClick={() => setSelectedId(null)}
            >
              收起
            </button>
          </div>
          <CapabilityConfig workspaceId={workspace.id} agentDef={selectedDef} />
        </div>
      )}

      {editingDef && (
        <AddAgentDialog
          editingDef={editingDef}
          onClose={async () => {
            setEditingDef(null);
            if (workspace) await loadAssignments(workspace.id);
          }}
        />
      )}
      {keyPrompt && (
        <PromptDialog
          title="更新 API Key"
          label="输入新的 API Key（运行中的实例需重启才生效）"
          password
          onSubmit={async (key) => {
            const instanceId = keyPrompt;
            setKeyPrompt(null);
            if (!key.trim()) {
              alert('API Key 不能为空');
              return;
            }
            try {
              await ipc.agent.updateApiKey(instanceId, key.trim());
              alert('API Key 已更新。若该实例正在运行，需停止后重新启动才生效。');
            } catch (err) {
              alert(`更新失败：${err instanceof Error ? err.message : String(err)}`);
            }
          }}
          onClose={() => setKeyPrompt(null)}
        />
      )}
    </div>
  );
}
