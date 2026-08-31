// 会话成员侧栏：显示当前选中会话的成员（agent 成员，SessionMemberInfo 三表 JOIN 产物）。
// v2.0 P1 Task 9：成员语义从 Matrix RoomMember 切换到 session_members——仅 agent 成员，
// 在线态直接读 lastRunning，leader 标识读 isLeader（建会快照）（不再查 assignments 反查）。
import { useSessionStore } from '../../stores/session.store';
import { cn } from '../../lib/cn';

export function MembersPanel() {
  const members = useSessionStore((s) => s.members);

  return (
    <aside className="absolute right-0 top-0 bottom-0 w-56 border-l border-border-subtle bg-bg-secondary shadow-xl overflow-auto z-30">
      <div className="px-3 py-2 text-xs text-neutral-500 border-b border-border-subtle">
        成员（{members.length}）
      </div>
      {members.map((m) => (
        <div key={m.instanceId} className="px-3 py-2 flex items-center gap-2 text-sm text-neutral-300">
          <span>{m.iconEmoji || '🤖'}</span>
          <span className="truncate flex-1">{m.agentName}</span>
          {m.isLeader && <span className="text-[10px] text-accent-blue">👑 Leader</span>}
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded shrink-0',
              m.lastRunning
                ? 'bg-status-success/20 text-status-success'
                : 'bg-bg-tertiary text-neutral-500',
            )}
          >
            {m.lastRunning ? '在线' : '离线'}
          </span>
        </div>
      ))}
    </aside>
  );
}
