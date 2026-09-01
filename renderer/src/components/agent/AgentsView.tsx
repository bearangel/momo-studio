// renderer/src/components/agent/AgentsView.tsx
// Agent 管理容器：双 Tab「Agent 成员」/「团队」（spec §6.1，v25 去编排）。
// 旧「本工作空间 / Agent 库」双 Tab 退役——Agent 定义管理由资源库承接，
// 成员/团队以 workspace 为维度在此管理。成员 Tab 底部保留 L2 工作空间
// 共享能力区（P3 挂载，CapabilityConfig）。
import { useState, useEffect } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { MembersPanel } from './MembersPanel';
import { TeamsPanel } from './TeamsPanel';
import { CapabilityConfig } from './CapabilityConfig';
import { cn } from '../../lib/cn';

type Tab = 'members' | 'teams';

export function AgentsView() {
  const [tab, setTab] = useState<Tab>('members');
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // 成员名称/图标/模型与团队 chips 都依赖 definitions join，在此统一加载
  const loadDefinitions = useAgentStore((s) => s.loadDefinitions);

  useEffect(() => {
    void loadDefinitions(activeWorkspaceId ?? undefined);
  }, [loadDefinitions, activeWorkspaceId]);

  return (
    <div className="flex flex-col flex-1 min-w-0 h-full">
      <div className="flex border-b border-border-subtle shrink-0">
        <button
          type="button"
          onClick={() => setTab('members')}
          className={cn(
            'px-4 py-2 text-sm border-b-2 -mb-px transition-colors',
            tab === 'members'
              ? 'border-accent-blue text-neutral-100'
              : 'border-transparent text-neutral-400 hover:text-neutral-200',
          )}
        >
          Agent 成员
        </button>
        <button
          type="button"
          onClick={() => setTab('teams')}
          className={cn(
            'px-4 py-2 text-sm border-b-2 -mb-px transition-colors',
            tab === 'teams'
              ? 'border-accent-blue text-neutral-100'
              : 'border-transparent text-neutral-400 hover:text-neutral-200',
          )}
        >
          团队
        </button>
      </div>
      <div className="flex-1 overflow-auto min-w-0">
        {tab === 'members' ? (
          <div className="flex flex-col h-full">
            <div className="flex-1 min-h-0">
              <MembersPanel />
            </div>
            {activeWorkspaceId && (
              <section
                aria-label="工作空间共享能力（L2）"
                className="border-t border-border-subtle p-4 shrink-0"
              >
                <h2 className="text-sm font-semibold text-neutral-200 mb-2">
                  工作空间共享能力（L2）
                </h2>
                <CapabilityConfig workspaceId={activeWorkspaceId} />
              </section>
            )}
          </div>
        ) : (
          <TeamsPanel />
        )}
      </div>
    </div>
  );
}
