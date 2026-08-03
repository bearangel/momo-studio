// renderer/src/components/agent/AgentsView.tsx
// Agent 管理容器：双 Tab（本工作空间 / Agent 库）
import { useState, useEffect } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { WorkspaceAgentsPanel } from './WorkspaceAgentsPanel';
import { AgentLibrary } from './AgentLibrary';
import { cn } from '../../lib/cn';

type Tab = 'workspace' | 'library';

export function AgentsView() {
  const [tab, setTab] = useState<Tab>('workspace');
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const loadDefinitions = useAgentStore((s) => s.loadDefinitions);
  const loadBuiltinSuggestions = useAgentStore((s) => s.loadBuiltinSuggestions);

  useEffect(() => {
    void loadDefinitions(activeWorkspaceId ?? undefined);
  }, [loadDefinitions, activeWorkspaceId]);

  useEffect(() => {
    void loadBuiltinSuggestions();
  }, [loadBuiltinSuggestions]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-border-subtle shrink-0">
        <button
          type="button"
          onClick={() => setTab('workspace')}
          className={cn(
            'px-4 py-2 text-sm border-b-2 -mb-px transition-colors',
            tab === 'workspace'
              ? 'border-accent-blue text-neutral-100'
              : 'border-transparent text-neutral-400 hover:text-neutral-200',
          )}
        >
          本工作空间
        </button>
        <button
          type="button"
          onClick={() => setTab('library')}
          className={cn(
            'px-4 py-2 text-sm border-b-2 -mb-px transition-colors',
            tab === 'library'
              ? 'border-accent-blue text-neutral-100'
              : 'border-transparent text-neutral-400 hover:text-neutral-200',
          )}
        >
          Agent 库
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {tab === 'workspace' ? <WorkspaceAgentsPanel /> : <AgentLibrary />}
      </div>
    </div>
  );
}
