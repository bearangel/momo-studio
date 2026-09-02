// renderer/src/components/im/MessageList.tsx
//
// 消息流：读取当前激活 room 的消息列表，自动滚动到底部。
// 空态分三种：未选 room / 加载中 / 无消息——v2.1 P2 Task 13 接 EmptyState 原子件
// （MessageSquare 图标，token 化语义色）。
//
// v2.0 A 子系统：不再在列表底部追加 activeRoomStreams（旧 v1.4 逻辑）。
// 每条 message 是否流式由 MessageBubble 内部按 message.id 查 stream.store 判断——
// streaming 时 MessageBubble 渲染 AgentStreamBubble，否则渲染静态消息。
import { useEffect, useRef } from 'react';
import { MessageSquare } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useBotNameMap } from '../../lib/useBotNames';
import { groupBySegment } from '../../lib/group-segments';
import type { ImMessage } from '../../ipc/types';
import { MessageBubble } from './MessageBubble';
import { SegmentStack } from './SegmentStack';
import { EmptyState } from '../ui/EmptyState';

export function MessageList() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const messages = useSessionStore((s) =>
    activeSessionId ? s.messagesBySession.get(activeSessionId) : undefined,
  );
  const loading = useSessionStore((s) => s.loading);
  const loadingOlder = useSessionStore((s) =>
    activeSessionId ? s.loadingOlderBySession.get(activeSessionId) ?? false : false,
  );
  const hasMore = useSessionStore((s) =>
    activeSessionId ? s.hasMoreBySession.get(activeSessionId) ?? true : true,
  );
  const loadOlder = useSessionStore((s) => s.loadOlder);
  // v2.0 P1 Task 11：无登录概念——单用户本地应用，本地用户消息 sender 固定 'owner'
  // （session-service.sendUserMessage 写入侧约定），气泡左右对齐据此判定
  const currentUserId = 'owner';
  const botNameByUserId = useBotNameMap();
  const scrollRef = useRef<HTMLDivElement>(null);
  const isFirstRender = useRef(true);
  const prevRoomIdRef = useRef<string | null>(activeSessionId);
  const isNearBottomRef = useRef(true);
  const pendingScrollRestore = useRef<number | null>(null);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (el.scrollTop === 0 && activeSessionId && !loadingOlder && hasMore) {
      pendingScrollRestore.current = el.scrollHeight;
      void loadOlder(activeSessionId);
    }
  };

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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isRoomChange = prevRoomIdRef.current !== activeSessionId;
    prevRoomIdRef.current = activeSessionId;
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
  }, [messages, activeSessionId]);

  if (!activeSessionId) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState icon={MessageSquare} title="未选择会话" description="在会话列表中选择一个房间开始对话" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState icon={MessageSquare} title="加载中…" />
      </div>
    );
  }

  if (!messages || messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState icon={MessageSquare} title="暂无消息" description="发送第一条消息开始对话" />
      </div>
    );
  }

  // v1.4 嵌套：dispatch/task_reply/子 agent 回复（含 parent_stream_session_id）
  // 不作为顶层独立消息渲染——它们已嵌套在 PM 气泡的 dispatch chip 内。
  const visibleMessages = (messages ?? []).filter((msg) => {
    if (msg.eventType === 'io.momo-studio.dispatch') return false;
    if (msg.eventType === 'io.momo-studio.task_reply') return false;
    if (msg.parentStreamSessionId) return false;
    return true;
  });

  const groupedItems = groupBySegment(visibleMessages);

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overflow-x-hidden py-4">
      {activeSessionId && loadingOlder && (
        <div className="text-center text-xs text-tertiary py-2">加载历史中…</div>
      )}
      {activeSessionId && !hasMore && !loadingOlder && (messages?.length ?? 0) > 0 && (
        <div className="text-center text-xs text-tertiary py-2">— 已到顶部 —</div>
      )}
      {groupedItems.map((item) => {
        if ('kind' in item && item.kind === 'segment-group') {
          return (
            <SegmentStack
              key={`seg-${item.streamSessionId}`}
              group={item}
              isSelf={item.segments[0]?.sender === currentUserId}
              senderName={botNameByUserId.get(item.segments[0]?.sender ?? '')}
            />
          );
        }
        const msg = item as ImMessage;
        return (
          <MessageBubble
            key={msg.id}
            message={msg}
            isSelf={msg.sender === currentUserId}
            senderName={botNameByUserId.get(msg.sender)}
          />
        );
      })}
    </div>
  );
}