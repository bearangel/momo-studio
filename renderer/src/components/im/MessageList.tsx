// renderer/src/components/im/MessageList.tsx
//
// 消息流：读取当前激活 room 的消息列表，自动滚动到底部。
// 空态分三种：未选 room / 加载中 / 无消息。
import { useEffect, useRef } from 'react';
import { useImStore } from '../../stores/im.store';
import { useAuthStore } from '../../stores/auth.store';
import { useBotNameMap } from '../../lib/useBotNames';
import { MessageBubble } from './MessageBubble';

export function MessageList() {
  const activeRoomId = useImStore((s) => s.activeRoomId);
  const messages = useImStore((s) =>
    activeRoomId ? s.messagesByRoom.get(activeRoomId) : undefined,
  );
  const loading = useImStore((s) => s.loading);
  const currentUserId = useAuthStore((s) => s.user?.userId ?? null);
  const botNameByUserId = useBotNameMap();
  const scrollRef = useRef<HTMLDivElement>(null);
  const isFirstRender = useRef(true);
  const prevRoomIdRef = useRef<string | null>(activeRoomId);

  // 消息列表变化时滚动到底部。
  // 组件首次渲染（含从其他视图切回 IM）或房间切换时用 'auto' 瞬间定位到最新消息，
  // 避免长历史会话从顶部平滑滚动很久；同一房间新消息到达用 'smooth' 平滑滚动。
  // 用容器 scrollTo 而非 scrollIntoView：后者在 flex + overflow 容器内不可靠。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isRoomChange = prevRoomIdRef.current !== activeRoomId;
    prevRoomIdRef.current = activeRoomId;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: isFirstRender.current || isRoomChange ? 'auto' : 'smooth',
    });
    isFirstRender.current = false;
  }, [messages, activeRoomId]);

  if (!activeRoomId) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500">
        <p className="text-sm">选择一个房间开始对话</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500">
        <p className="text-sm">加载中…</p>
      </div>
    );
  }

  if (!messages || messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500">
        <p className="text-sm">暂无消息，发送第一条吧</p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden py-4">
      {messages.map((msg) => (
        <MessageBubble
          key={msg.eventId}
          message={msg}
          isSelf={msg.sender === currentUserId}
          senderName={botNameByUserId.get(msg.sender)}
        />
      ))}
    </div>
  );
}
