// renderer/src/components/im/RoomList.tsx
//
// v2.2 bug 修复：会话列表项不再渲染任何图标（用户要求移除「各种图标」——
// 成员 emoji / Crown / Bot 兜底 / MessageSquare / +N 溢出计数全部下线；
// 成员身份信息在会话面板成员区查看）。悬停操作按钮（重命名/解散）保留。
// 会话创建入口已迁 SessionSidebarHeader（侧边栏头部 Bolt/Users 双常驻按钮）。
//
// v2.1 P2 Task 11：选中态用 design-system §1 文档 accent form
//（bg-surface-active + text-accent-600/300），空态接 EmptyState，
// hover 工具条 Pencil/Trash2 lucide 化（去 emoji）。
import { useEffect, useState } from 'react';
import { useSessionStore } from '../../stores/session.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { ipc } from '../../ipc/client';
import { PromptDialog } from '../common/PromptDialog';
import { EmptyState } from '../ui/EmptyState';
import { cn } from '../../lib/cn';
import { MessageSquare, Pencil, Trash2 } from 'lucide-react';

export function RoomList() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  const loadSessions = useSessionStore((s) => s.loadSessions);
  const refreshSessionList = useSessionStore((s) => s.refreshSessionList);
  const loading = useSessionStore((s) => s.loading);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const [renaming, setRenaming] = useState<{ sessionId: string; oldTitle: string } | null>(null);

  const submitRename = async (name: string) => {
    const target = renaming;
    setRenaming(null);
    if (target && name.trim() && name !== target.oldTitle) {
      await ipc.session.rename(target.sessionId, name.trim());
      refreshSessionList();
    }
  };

  const handleDissolve = async (sessionId: string, title: string) => {
    if (!confirm(`确定解散会话「${title}」？\n所有成员将被移除。`)) return;
    try {
      await ipc.session.delete(sessionId);
      refreshSessionList();
    } catch (err) {
      alert(`解散失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  useEffect(() => {
    // 切换 workspace 时按当前 workspace 过滤会话；首次加载若 workspace 尚未就绪则拉全部
    void loadSessions(activeWorkspaceId ?? undefined);
  }, [loadSessions, activeWorkspaceId]);

  if (loading && sessions.length === 0) {
    return (
      <div className="w-full flex-1 min-h-0 bg-surface-1 flex items-center justify-center">
        <p className="text-sm text-tertiary">加载中…</p>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="w-full flex-1 min-h-0 bg-surface-1 flex items-center justify-center">
        <EmptyState
          icon={MessageSquare}
          title="暂无会话"
          description="用上方「快速会话」或「协作会话」按钮开始对话"
          action={
            <button
              type="button"
              onClick={() => void loadSessions()}
              className="text-xs text-accent-600 dark:text-accent-300 hover:underline mt-1"
            >
              刷新
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="w-full flex-1 min-h-0 bg-surface-1 overflow-auto">
      {sessions.map((session) => (
        // 外层 group 让 group-hover 生效；悬停时叠加操作按钮
        <div key={session.id} className="group relative">
          <button
            type="button"
            onClick={() => void selectSession(session.id)}
            className={cn(
              'w-full text-left px-3 py-2.5 text-sm transition-colors border-l-2 flex items-center',
              session.id === activeSessionId
                ? 'bg-surface-active border-transparent text-accent-600 dark:text-accent-300'
                : 'border-transparent text-secondary hover:bg-surface-3',
            )}
          >
            <span className="truncate flex-1">{session.title}</span>
          </button>
          <span className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1 rounded bg-surface-1/90 px-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              title="重命名"
              onClick={(e) => {
                e.stopPropagation();
                setRenaming({ sessionId: session.id, oldTitle: session.title });
              }}
              className="text-tertiary hover:text-primary"
              aria-label="重命名"
            >
              <Pencil size={12} strokeWidth={1.75} aria-hidden />
            </button>
            <button
              type="button"
              title="解散"
              onClick={(e) => {
                e.stopPropagation();
                void handleDissolve(session.id, session.title);
              }}
              className="text-tertiary hover:text-status-error"
              aria-label="解散"
            >
              <Trash2 size={12} strokeWidth={1.75} aria-hidden />
            </button>
          </span>
        </div>
      ))}
      {renaming && (
        <PromptDialog
          title="重命名会话"
          defaultValue={renaming.oldTitle}
          onSubmit={submitRename}
          onClose={() => setRenaming(null)}
        />
      )}
    </div>
  );
}
