// 会话成员侧栏：显示当前选中会话的成员（agent 成员，SessionMemberInfo 三表 JOIN 产物）。
// v2.0 P1 Task 9：成员语义从 Matrix RoomMember 切换到 session_members——仅 agent 成员，
// 在线态直接读 lastRunning，leader 标识读 isLeader（建会快照）（不再查 assignments 反查）。
//
// v2.1 P2 Task 13：token 化——border-l/border-subtle + bg-surface-1 + shadow-lg；
// leader 徽标 👑 → lucide-react Crown（accent token 配色）。
import { Bot, Crown } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { cn } from '../../lib/cn';

export function MembersPanel() {
  const members = useSessionStore((s) => s.members);

  return (
    <aside className="absolute right-0 top-0 bottom-0 w-56 border-l border-subtle bg-surface-1 shadow-lg overflow-auto z-30">
      <div className="px-3 py-2 text-xs text-tertiary border-b border-subtle">
        成员（{members.length}）
      </div>
      {members.map((m) => (
        <div key={m.instanceId} className="px-3 py-2 flex items-center gap-2 text-sm text-secondary">
          <span>{m.iconEmoji ?? <Bot size={12} strokeWidth={1.75} aria-hidden />}</span>
          <span className="truncate flex-1">{m.agentName}</span>
          {m.isLeader && (
            <span
              data-testid="leader-badge"
              className="inline-flex items-center gap-0.5 text-[10px] text-accent-600 dark:text-accent-300"
            >
              <Crown size={10} strokeWidth={1.75} aria-hidden />
              Leader
            </span>
          )}
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded shrink-0',
              m.lastRunning
                ? 'bg-status-success/20 text-status-success'
                : 'bg-surface-3 text-tertiary',
            )}
          >
            {m.lastRunning ? '在线' : '离线'}
          </span>
        </div>
      ))}
    </aside>
  );
}
