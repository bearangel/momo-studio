// 群成员侧栏：显示当前选中房间的成员，含身份标识 + agent 在线/离线状态。
// bot 成员通过 assignment.lastRunning 判断在线/离线，显示对应 badge。
import { useImStore } from '../../stores/im.store';
import { useAgentStore } from '../../stores/agent.store';
import { useBotNameMap } from '../../lib/useBotNames';
import { cn } from '../../lib/cn';

export function MembersPanel() {
  const members = useImStore((s) => s.members);
  const botNameMap = useBotNameMap();
  const assignments = useAgentStore((s) => s.assignments);

  /** 查 member userId 对应的 agent 是否在线（基于 assignment.lastRunning）。无 assignment 返回 null（不显示标签） */
  const isAgentOnline = (userId: string): boolean | null => {
    const a = assignments.find((item) => item.agentUserId === userId);
    if (!a) return null;
    return a.lastRunning;
  };

  return (
    <aside className="absolute right-0 top-0 bottom-0 w-56 border-l border-border-subtle bg-bg-secondary shadow-xl overflow-auto z-30">
      <div className="px-3 py-2 text-xs text-neutral-500 border-b border-border-subtle">
        成员（{members.length}）
      </div>
      {members.map((m) => {
        const online = m.isBot ? isAgentOnline(m.userId) : null;
        return (
          <div key={m.userId} className="px-3 py-2 flex items-center gap-2 text-sm text-neutral-300">
            <span>{m.isLocalUser ? '⭐' : m.isBot ? '🤖' : '👤'}</span>
            <span className="truncate flex-1">{botNameMap.get(m.userId) ?? m.displayName}</span>
            {m.powerLevel >= 50 && <span className="text-[10px] text-accent-blue">管理</span>}
            {online !== null && (
              <span
                className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded shrink-0',
                  online
                    ? 'bg-status-success/20 text-status-success'
                    : 'bg-bg-tertiary text-neutral-500',
                )}
              >
                {online ? '在线' : '离线'}
              </span>
            )}
          </div>
        );
      })}
    </aside>
  );
}
