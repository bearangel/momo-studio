// renderer/src/components/agent/AgentList.tsx
// 当前 workspace 内已分配的 agent 列表 + "添加 agent" 按钮。
// 每个 agent 显示名称、状态徽章（运行中/已停止）、停止按钮。
import { useEffect } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';

interface Props {
  onAdd: () => void;
}

export function AgentList({ onAdd }: Props) {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { assignments, definitions, running, loading, loadDefinitions, loadAssignments } =
    useAgentStore();

  useEffect(() => {
    void loadDefinitions();
  }, [loadDefinitions]);

  useEffect(() => {
    if (workspace) void loadAssignments(workspace.id);
  }, [workspace, loadAssignments]);

  // 按 definitionId 反查 agent 定义（取名称/图标）
  const defMap = new Map(definitions.map((d) => [d.id, d]));

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
              return (
                <li
                  key={a.instanceId}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg bg-bg-tertiary border border-border-subtle"
                >
                  <span className="text-xl">{def?.iconEmoji ?? '🤖'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-neutral-100 truncate">
                      {def?.name ?? a.agentDefinitionId}
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
                      onClick={() => void useAgentStore.getState().stopAgent(a.instanceId)}
                    >
                      停止
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
