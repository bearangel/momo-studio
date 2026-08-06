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
  const loadingOlder = useImStore((s) =>
    activeRoomId ? s.loadingOlderByRoom.get(activeRoomId) ?? false : false,
  );
  const hasMore = useImStore((s) =>
    activeRoomId ? s.hasMoreByRoom.get(activeRoomId) ?? true : true,
  );
  const loadOlder = useImStore((s) => s.loadOlder);
  const currentUserId = useAuthStore((s) => s.user?.userId ?? null);
  const botNameByUserId = useBotNameMap();
  const streams = useStreamStore((s) => s.streams);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isFirstRender = useRef(true);
  const prevRoomIdRef = useRef<string | null>(activeRoomId);
  const isNearBottomRef = useRef(true);
  // v1.5.4：分页加载期间的滚动位置保持——loadOlder 前记 scrollHeight，
  // useEffect 检测到 messages 增长且 pendingScrollRestore 有值时恢复相对位置
  const pendingScrollRestore = useRef<number | null>(null);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    // 滚到顶部触发向前翻页（防抖在 store 内处理；到底短路在 store + 这里双重判断）
    if (el.scrollTop === 0 && activeRoomId && !loadingOlder && hasMore) {
      pendingScrollRestore.current = el.scrollHeight;
      void loadOlder(activeRoomId);
    }
  };

  // v1.5.4：messages 增长 + 有待恢复的滚动位置 → 把 scrollTop 调到新内容下方
  // （视觉上用户停在原位置，新历史加载到上方不干扰）
  useEffect(() => {
    if (pendingScrollRestore.current === null) return;
    const el = scrollRef.current;
    if (!el) return;
    const prevHeight = pendingScrollRestore.current;
    pendingScrollRestore.current = null;
    const delta = el.scrollHeight - prevHeight;
    if (delta > 0) {
      el.scrollTop = delta;
    }
  }, [messages, loadingOlder]);

  // 当前房间的顶层流式会话（排除子 agent——子 agent 的 stream 有 parentStreamSessionId，
  // 仅在 PM 气泡的 DispatchChip 内嵌套渲染，不作为独立顶层气泡）。
  const activeRoomStreams = activeRoomId
    ? Array.from(streams.values()).filter(
        (s) => s.roomId === activeRoomId && !s.parentStreamSessionId,
      )
    : [];

  // 已有 StreamState 的 streamSessionId 集合——用于过滤重复的 Matrix 消息
  const streamSessionIds = new Set(activeRoomStreams.map((s) => s.streamSessionId));

  // 消息或流式状态变化时滚动到底部。
  // 组件首次渲染（含从其他视图切回 IM）或房间切换时用 'auto' 瞬间定位到最新消息，
  // 避免长历史会话从顶部平滑滚动很久；同一房间新消息到达用 'smooth' 平滑滚动。
  // 用容器 scrollTo 而非 scrollIntoView：后者在 flex + overflow 容器内不可靠。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isRoomChange = prevRoomIdRef.current !== activeRoomId;
    prevRoomIdRef.current = activeRoomId;
    // 分页加载时不触发"滚到底部"——否则会把用户从顶部拉回底部，破坏视觉位置
    if (pendingScrollRestore.current !== null) {
      isFirstRender.current = false;
      return;
    }

    if (isFirstRender.current || isRoomChange) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    } else if (isNearBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    }
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

  // v1.4 嵌套：dispatch/task_reply/子 agent 回复（含 parent_stream_session_id）
  // 不作为顶层独立消息渲染——它们已嵌套在 PM 气泡的 dispatch chip 内。
  // 仅过滤渲染层，store 原始消息保留（历史还原仍可访问）。
  const visibleMessages = (messages ?? []).filter((msg) => {
    if (msg.eventType === 'io.momo-studio.dispatch') return false;
    if (msg.eventType === 'io.momo-studio.task_reply') return false;
    if (msg.content?.['io.momo-studio.parent_stream_session_id']) return false;
    // 已有 StreamState 渲染为 AgentStreamBubble 的消息不再重复渲染为 MessageBubble
    const sessionId = msg.content?.['io.momo-studio.stream_session_id'];
    if (typeof sessionId === 'string' && streamSessionIds.has(sessionId)) return false;
    return true;
  });

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overflow-x-hidden py-4">
      {/* v1.5.4：分页加载状态指示——加载中显示提示；已到顶部（无更早历史）显示分隔线 */}
      {activeRoomId && loadingOlder && (
        <div className="text-center text-xs text-neutral-500 py-2">加载历史中…</div>
      )}
      {activeRoomId && !hasMore && !loadingOlder && (messages?.length ?? 0) > 0 && (
        <div className="text-center text-xs text-neutral-500 py-2">— 已到顶部 —</div>
      )}
      {visibleMessages.map((msg) => (
        <MessageBubble
          key={msg.eventId}
          message={msg}
          isSelf={msg.sender === currentUserId}
          senderName={botNameByUserId.get(msg.sender)}
          allMessages={messages}
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
