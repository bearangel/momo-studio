// renderer/src/components/im/RoomList.tsx
import { useEffect } from 'react';
import { useImStore } from '../../stores/im.store';
import { cn } from '../../lib/cn';

export function RoomList() {
  const rooms = useImStore((s) => s.rooms);
  const activeRoomId = useImStore((s) => s.activeRoomId);
  const selectRoom = useImStore((s) => s.selectRoom);
  const loadRooms = useImStore((s) => s.loadRooms);
  const loading = useImStore((s) => s.loading);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  if (loading && rooms.length === 0) {
    return (
      <div className="w-60 shrink-0 border-r border-border-subtle bg-bg-secondary flex items-center justify-center">
        <p className="text-sm text-neutral-500">加载中…</p>
      </div>
    );
  }

  if (rooms.length === 0) {
    return (
      <div className="w-60 shrink-0 border-r border-border-subtle bg-bg-secondary flex flex-col items-center justify-center gap-2">
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

  return (
    <div className="w-60 shrink-0 border-r border-border-subtle bg-bg-secondary overflow-auto">
      {rooms.map((room) => (
        <button
          key={room.roomId}
          type="button"
          onClick={() => void selectRoom(room.roomId)}
          className={cn(
            'w-full text-left px-3 py-2.5 text-sm transition-colors border-l-2',
            room.roomId === activeRoomId
              ? 'bg-bg-tertiary border-accent-blue text-neutral-100'
              : 'border-transparent text-neutral-300 hover:bg-bg-tertiary/60',
          )}
        >
          <span className="truncate block">{room.name}</span>
        </button>
      ))}
    </div>
  );
}
