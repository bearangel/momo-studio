// renderer/src/components/im/RoomList.tsx
//
// IM 左侧房间列表。点击切换激活 room，触发 MessageList 刷新。
// M1 简化：房间名直接取 Matrix room.name（无名字时回退到 roomId）。
import { useImStore } from '../../stores/im.store';
import { cn } from '../../lib/cn';

export function RoomList() {
  const rooms = useImStore((s) => s.rooms);
  const activeRoomId = useImStore((s) => s.activeRoomId);
  const selectRoom = useImStore((s) => s.selectRoom);

  if (rooms.length === 0) {
    return (
      <div className="w-60 shrink-0 border-r border-border-subtle bg-bg-secondary flex items-center justify-center">
        <p className="text-sm text-neutral-500 px-4 text-center">暂无房间</p>
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
