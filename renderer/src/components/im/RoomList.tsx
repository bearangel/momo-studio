// renderer/src/components/im/RoomList.tsx
import { useEffect, useState } from 'react';
import { useImStore } from '../../stores/im.store';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { ipc } from '../../ipc/client';
import { CreateRoomDialog } from './CreateRoomDialog';
import { PromptDialog } from '../common/PromptDialog';
import { cn } from '../../lib/cn';
import { useBotNameMap, resolveBotName } from '../../lib/useBotNames';

export function RoomList() {
  const rooms = useImStore((s) => s.rooms);
  const activeRoomId = useImStore((s) => s.activeRoomId);
  const selectRoom = useImStore((s) => s.selectRoom);
  const loadRooms = useImStore((s) => s.loadRooms);
  const refreshRoomList = useImStore((s) => s.refreshRoomList);
  const loading = useImStore((s) => s.loading);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  // 新建房间对话框状态 + 邀请候选（当前 workspace 内启用的 agent bot）
  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ roomId: string; oldName: string } | null>(null);
  const { assignments } = useAgentStore();
  const botNameMap = useBotNameMap();

  const inviteCandidates = assignments
    .filter((a) => a.enabled)
    .map((a) => ({
      userId: a.agentUserId,
      displayName: resolveBotName(a.agentUserId, botNameMap),
    }));

  const handleRename = (roomId: string, oldName: string) => {
    setRenaming({ roomId, oldName });
  };

  const submitRename = async (name: string) => {
    const target = renaming;
    setRenaming(null);
    if (target && name.trim() && name !== target.oldName) {
      await ipc.im.renameRoom(target.roomId, name.trim());
      refreshRoomList();
    }
  };

  const handleDissolve = async (roomId: string, name: string) => {
    if (!confirm(`确定解散房间「${name}」？\n所有成员将被移除。`)) return;
    try {
      const r = await ipc.im.dissolveRoom(roomId);
      if (!r.dissolved) alert('部分成员凭证丢失，已退出但未完全解散');
      refreshRoomList();
    } catch (err) {
      alert(`解散失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  useEffect(() => {
    // 切换 workspace 时按当前 workspace 过滤房间；首次加载若 workspace 尚未就绪则拉全部
    void loadRooms(activeWorkspaceId ?? undefined);
  }, [loadRooms, activeWorkspaceId]);

  if (loading && rooms.length === 0) {
    return (
      <div className="w-full h-full bg-bg-secondary flex items-center justify-center">
        <p className="text-sm text-neutral-500">加载中…</p>
      </div>
    );
  }

  if (rooms.length === 0) {
    return (
      <div className="w-full h-full bg-bg-secondary flex flex-col items-center justify-center gap-2">
        <div className="text-3xl">💬</div>
        <p className="text-sm text-neutral-500 px-4 text-center">
          暂无房间
          <br />
          创建 workspace 后会自动生成团队群
        </p>
        <button
          type="button"
          onClick={() => void loadRooms()}
          className="text-xs text-accent-blue hover:underline mt-1"
        >
          刷新
        </button>
      </div>
    );
  }

  // 系统通知 + 团队群顶置，其余按原序（stable sort 保持相对顺序）
  const sortedRooms = [...rooms].sort((a, b) => {
    const priority = (r: (typeof rooms)[number]) =>
      r.isSystem ? 0 : workspaces.some((w) => w.teamSessionId === r.roomId) ? 1 : 2;
    return priority(a) - priority(b);
  });

  return (
    <div className="w-full h-full bg-bg-secondary overflow-auto">
      {/* 顶部新建按钮 */}
      <button
        type="button"
        onClick={() => setCreateOpen(true)}
        className="m-2 text-xs px-2 py-1 rounded bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30"
      >
        + 新建房间
      </button>
      {sortedRooms.map((room) => (
        // 外层 group 让 group-hover 生效；非 system 房间悬停时叠加操作按钮
        <div key={room.roomId} className="group relative">
          <button
            type="button"
            onClick={() => void selectRoom(room.roomId)}
            className={cn(
              'w-full text-left px-3 py-2.5 text-sm transition-colors border-l-2 flex items-center gap-2',
              room.roomId === activeRoomId
                ? 'bg-bg-tertiary border-accent-blue text-neutral-100'
                : 'border-transparent text-neutral-300 hover:bg-bg-tertiary/60',
            )}
          >
            {room.isSystem && <span className="text-xs">⚙️</span>}
            <span className="truncate flex-1">{room.name}</span>
            {room.isSystem && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-neutral-400 shrink-0">
                系统
              </span>
            )}
          </button>
          {/* 团队群（任一 workspace 的 teamRoomId）受保护，显示锁标记、无解散/重命名 */}
          {(() => {
            const isTeamRoom = workspaces.some((w) => w.teamSessionId === room.roomId);
            if (isTeamRoom) {
              return (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-neutral-500"       title="团队群随工作空间删除">
                  🔒
                </span>
              );
            }
            if (room.isSystem) return null;
            return (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1 rounded bg-bg-secondary/90 px-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleRename(room.roomId, room.name);
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
                    void handleDissolve(room.roomId, room.name);
                  }}
                  className="text-neutral-500 hover:text-red-400 text-xs"
                >
                  🗑
                </button>
              </span>
            );
          })()}
        </div>
      ))}
      <CreateRoomDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => refreshRoomList()}
        inviteCandidates={inviteCandidates}
      />
      {renaming && (
        <PromptDialog
          title="重命名房间"
          defaultValue={renaming.oldName}
          onSubmit={submitRename}
          onClose={() => setRenaming(null)}
        />
      )}
    </div>
  );
}
