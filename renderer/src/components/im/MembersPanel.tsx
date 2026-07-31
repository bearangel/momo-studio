// 群成员侧栏：显示当前选中房间的成员，含身份标识
import { useImStore } from '../../stores/im.store';

export function MembersPanel() {
  const members = useImStore((s) => s.members);
  return (
    <aside className="w-48 shrink-0 border-l border-border-subtle bg-bg-secondary overflow-auto">
      <div className="px-3 py-2 text-xs text-neutral-500 border-b border-border-subtle">成员（{members.length}）</div>
      {members.map((m) => (
        <div key={m.userId} className="px-3 py-2 flex items-center gap-2 text-sm text-neutral-300">
          <span>{m.isLocalUser ? '⭐' : m.isBot ? '🤖' : '👤'}</span>
          <span className="truncate flex-1">{m.displayName}</span>
          {m.powerLevel >= 50 && <span className="text-[10px] text-accent-blue">管理</span>}
        </div>
      ))}
    </aside>
  );
}
