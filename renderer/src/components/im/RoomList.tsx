// renderer/src/components/im/RoomList.tsx
import { useEffect, useState } from 'react';
import { useSessionStore } from '../../stores/session.store';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { ipc } from '../../ipc/client';
import { CreateRoomDialog } from './CreateRoomDialog';
import { PromptDialog } from '../common/PromptDialog';
import { cn } from '../../lib/cn';
import { useBotNameMap, resolveBotName } from '../../lib/useBotNames';

export function RoomList() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  const loadSessions = useSessionStore((s) => s.loadSessions);
  const refreshSessionList = useSessionStore((s) => s.refreshSessionList);
  const loading = useSessionStore((s) => s.loading);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  // 新建会话对话框状态 + 目标候选（当前 workspace 的 agent 成员；v25 成员制无 enabled）
  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ sessionId: string; oldTitle: string } | null>(null);
  const { assignments } = useAgentStore();
  const botNameMap = useBotNameMap();

  const inviteCandidates = assignments.map((a) => ({
    instanceId: a.instanceId,
    displayName: resolveBotName(a.agentUserId, botNameMap),
  }));

  const handleRename = (sessionId: string, oldTitle: string) => {
    setRenaming({ sessionId, oldTitle });
  };

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
      <div className="w-full h-full bg-bg-secondary flex items-center justify-center">
        <p className="text-sm text-neutral-500">加载中…</p>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="w-full h-full bg-bg-secondary flex flex-col items-center justify-center gap-2">
        <div className="text-3xl">💬</div>
        <p className="text-sm text-neutral-500 px-4 text-center">
          暂无会话
          <br />
          点击下方按钮新建
        </p>
        <button
          type="button"
          onClick={() => void loadSessions()}
          className="text-xs text-accent-blue hover:underline mt-1"
        >
          刷新
        </button>
      </div>
    );
  }

  // v25：团队会话（workspace.teamSessionId）概念退役，会话一律按原序展示、可重命名/解散。
  const sortedSessions = [...sessions];

  return (
    <div className="w-full h-full bg-bg-secondary overflow-auto">
      {/* 顶部新建按钮 */}
      <button
        type="button"
        onClick={() => setCreateOpen(true)}
        className="m-2 text-xs px-2 py-1 rounded bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30"
      >
        + 新建会话
      </button>
      {sortedSessions.map((session) => (
        // 外层 group 让 group-hover 生效；悬停时叠加操作按钮
        <div key={session.id} className="group relative">
          <button
            type="button"
            onClick={() => void selectSession(session.id)}
            className={cn(
              'w-full text-left px-3 py-2.5 text-sm transition-colors border-l-2 flex items-center gap-2',
              session.id === activeSessionId
                ? 'bg-bg-tertiary border-accent-blue text-neutral-100'
                : 'border-transparent text-neutral-300 hover:bg-bg-tertiary/60',
            )}
          >
            <span className="truncate flex-1">{session.title}</span>
          </button>
          <span className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1 rounded bg-bg-secondary/90 px-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              title="重命名"
              onClick={(e) => {
                e.stopPropagation();
                void handleRename(session.id, session.title);
              }}
              className="text-neutral-500 hover:text-neutral-200 text-xs"
            >
              ✏️
            </button>
            <button
              type="button"
              title="解散"
              onClick={(e) => {
                e.stopPropagation();
                void handleDissolve(session.id, session.title);
              }}
              className="text-neutral-500 hover:text-red-400 text-xs"
            >
              🗑
            </button>
          </span>
        </div>
      ))}
      <CreateRoomDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => refreshSessionList()}
        inviteCandidates={inviteCandidates}
      />
      {renaming && (
        <PromptDialog
          title="重命名房间"
          defaultValue={renaming.oldTitle}
          onSubmit={submitRename}
          onClose={() => setRenaming(null)}
        />
      )}
    </div>
  );
}
