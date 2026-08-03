// renderer/src/components/im/MessageList.tsx
//
// 消息流：读取当前激活 room 的消息列表，自动滚动到底部。
// 空态分三种：未选 room / 加载中 / 无消息。
// v1.4：消息列表底部追加当前房间的活跃流式气泡（AgentStreamBubble），
//       数据来自 stream.store 的 streaming 状态。
import { useEffect, useRef } from 'react';
import { useImStore } from '../../stores/im.store';
import { useAuthStore } from '../../stores/auth.store';
import { useStreamStore } from '../../stores/stream.store';
import { useBotNameMap } from '../../lib/useBotNames';
import { MessageBubble } from './MessageBubble';
import { AgentStreamBubble } from './AgentStreamBubble';

export function MessageList() {
  const activeRoomId = useImStore((s) => s.activeRoomId);
  const messages = useImStore((s) =>
    activeRoomId ? s.messagesByRoom.get(activeRoomId) : undefined,
  );
  const loading = useImStore((s) => s.loading);
  const currentUserId = useAuthStore((s) => s.user?.userId ?? null);
  const botNameByUserId = useBotNameMap();
  const streams = useStreamStore((s) => s.streams);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isFirstRender = useRef(true);
  const prevRoomIdRef = useRef<string | null>(activeRoomId);

  // 当前房间的活跃流式会话（status=streaming）
  const activeRoomStreams = activeRoomId
    ? Array.from(streams.values()).filter(
        (s) => s.roomId === activeRoomId && s.status === 'streaming',
      )
    : [];

  // 消息或流式状态变化时滚动到底部。
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
  }, [messages, activeRoomId, activeRoomStreams]);

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

  // 无消息且无活跃流式 → 空态
  if ((!messages || messages.length === 0) && activeRoomStreams.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500">
        <p className="text-sm">暂无消息，发送第一条吧</p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden py-4">
      {messages?.map((msg) => (
        <MessageBubble
          key={msg.eventId}
          message={msg}
          isSelf={msg.sender === currentUserId}
          senderName={botNameByUserId.get(msg.sender)}
        />
      ))}
      {activeRoomStreams.map((stream) => (
        <AgentStreamBubble
          key={stream.streamSessionId}
          stream={stream}
          senderName={botNameByUserId.get(stream.botUserId)}
        />
      ))}
    </div>
  );
}
