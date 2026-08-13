// renderer/src/components/im/MessageList.tsx
//
// 消息流：读取当前激活 room 的消息列表，自动滚动到底部。
// 空态分三种：未选 room / 加载中 / 无消息。
//
// v2.0 A 子系统：不再在列表底部追加 activeRoomStreams（旧 v1.4 逻辑）。
// 每条 message 是否流式由 MessageBubble 内部按 message.id 查 stream.store 判断——
// streaming 时 MessageBubble 渲染 AgentStreamBubble，否则渲染静态消息。
import { useEffect, useRef } from 'react';
import { useImStore } from '../../stores/im.store';
import { useAuthStore } from '../../stores/auth.store';
import { useBotNameMap } from '../../lib/useBotNames';
import type { ImMessage } from '../../ipc/types';
import { MessageBubble } from './MessageBubble';
import { SegmentStack } from './SegmentStack';
import type { SegmentGroup } from './types';

/**
 * v1.7.4 Bug 2：按 io.momo-studio.segment_of 字段归组多段 task_complete 消息。
 *
 * 重启还原场景：runtime 写了 segment_of + segment_index 字段，但 v1.7.3 之前
 * renderer 不识别——重启后 N 段消息显示为 N 个独立气泡，与重启前 UI 完全不同。
 * 现按 segment_of 聚合为 SegmentGroup，交给 SegmentStack 纵向堆叠渲染。
 *
 * 单段消息（无 segment_of，或归组后只有一段）保持原 MessageBubble 渲染。
 *
 * v2.0 A 子系统：segmentOf / segmentIndex / createdAt 直接来自 SQLite messages 表字段，
 * 不再从 Matrix event content 读取。
 */
function groupBySegment(messages: ImMessage[]): Array<ImMessage | SegmentGroup> {
  const segmentMap = new Map<string, ImMessage[]>();
  const standalone: ImMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.segmentOf === 'string') {
      if (!segmentMap.has(msg.segmentOf)) segmentMap.set(msg.segmentOf, []);
      segmentMap.get(msg.segmentOf)!.push(msg);
    } else {
      standalone.push(msg);
    }
  }

  const result: Array<ImMessage | SegmentGroup> = [...standalone];
  for (const [streamSessionId, segments] of segmentMap) {
    segments.sort((a, b) => (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0));
    if (segments.length === 1) {
      const only = segments[0];
      if (only) result.push(only);
    } else if (segments.length > 1) {
      const last = segments[segments.length - 1];
      result.push({
        kind: 'segment-group',
        streamSessionId,
        segments,
        lastSegmentAt: last ? last.createdAt : Date.now(),
      });
    }
  }
  return result;
}


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
  const scrollRef = useRef<HTMLDivElement>(null);
  const isFirstRender = useRef(true);
  const prevRoomIdRef = useRef<string | null>(activeRoomId);
  const isNearBottomRef = useRef(true);
  const pendingScrollRestore = useRef<number | null>(null);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (el.scrollTop === 0 && activeRoomId && !loadingOlder && hasMore) {
      pendingScrollRestore.current = el.scrollHeight;
      void loadOlder(activeRoomId);
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
    const isRoomChange = prevRoomIdRef.current !== activeRoomId;
    prevRoomIdRef.current = activeRoomId;
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
      {activeRoomId && loadingOlder && (
        <div className="text-center text-xs text-neutral-500 py-2">加载历史中…</div>
      )}
      {activeRoomId && !hasMore && !loadingOlder && (messages?.length ?? 0) > 0 && (
        <div className="text-center text-xs text-neutral-500 py-2">— 已到顶部 —</div>
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
