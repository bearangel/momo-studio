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
import type { ImMessage } from '../../ipc/types';
import { MessageBubble } from './MessageBubble';
import { AgentStreamBubble } from './AgentStreamBubble';
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
    // 按 segment_index 升序排序（null 视为 0）
    segments.sort((a, b) => (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0));
    if (segments.length === 1) {
      // 单段消息不归组（fallback 到普通 MessageBubble）
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
  // v1.5.7: team room 消息——合并到 allMessages 让 DispatchChip 跨房间搜索子 agent 消息
  const teamRoomMessages = useImStore((s) => s.teamRoomMessages);
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
  // v2.0 A 子系统：stream_session_id / parent_stream_session_id 来自 SQLite messages 字段。
  const visibleMessages = (messages ?? []).filter((msg) => {
    if (msg.eventType === 'io.momo-studio.dispatch') return false;
    if (msg.eventType === 'io.momo-studio.task_reply') return false;
    if (msg.parentStreamSessionId) return false;
    // 已有 StreamState 渲染为 AgentStreamBubble 的消息不再重复渲染为 MessageBubble
    if (typeof msg.streamSessionId === 'string' && streamSessionIds.has(msg.streamSessionId)) return false;
    return true;
  });

  // v1.5.6: messages + streams 合并按 createdAt 混合排序，避免 stream 永远在末尾。
  // 用户报"msg3 出现在 agent 回复前面"就是因为 messages 在前 streams 在后分两段渲染。
  // 现在统一按时间排序：messages 用 msg.createdAt，streams 用 stream.startedAt。
  // v1.7.4：多段消息先按 segment_of 归组为 SegmentGroup（用 lastSegmentAt 排序）。
  // v2.0 A 子系统：createdAt 来自 SQLite messages 表（替代旧 Matrix event timestamp）。
  const groupedItems = groupBySegment(visibleMessages);
  type MixedItem =
    | { kind: 'message'; msg: ImMessage; ts: number }
    | { kind: 'segment-group'; group: SegmentGroup; ts: number }
    | { kind: 'stream'; stream: typeof activeRoomStreams[number]; ts: number };
  const mixedItems: MixedItem[] = [
    ...groupedItems.map((item) =>
      'kind' in item && item.kind === 'segment-group'
        ? { kind: 'segment-group' as const, group: item, ts: item.lastSegmentAt }
        : { kind: 'message' as const, msg: item as ImMessage, ts: (item as ImMessage).createdAt },
    ),
    ...activeRoomStreams.map((stream) => ({ kind: 'stream' as const, stream, ts: stream.startedAt })),
  ].sort((a, b) => a.ts - b.ts);

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overflow-x-hidden py-4">
      {/* v1.5.4：分页加载状态指示——加载中显示提示；已到顶部（无更早历史）显示分隔线 */}
      {activeRoomId && loadingOlder && (
        <div className="text-center text-xs text-neutral-500 py-2">加载历史中…</div>
      )}
      {activeRoomId && !hasMore && !loadingOlder && (messages?.length ?? 0) > 0 && (
        <div className="text-center text-xs text-neutral-500 py-2">— 已到顶部 —</div>
      )}
      {mixedItems.map((item) => {
        if (item.kind === 'segment-group') {
          return (
            <SegmentStack
              key={`seg-${item.group.streamSessionId}`}
              group={item.group}
              isSelf={item.group.segments[0]?.sender === currentUserId}
              senderName={botNameByUserId.get(item.group.segments[0]?.sender ?? '')}
              allMessages={[...(messages ?? []), ...teamRoomMessages]}
            />
          );
        }
        if (item.kind === 'message') {
          return (
            <MessageBubble
              key={item.msg.id}
              message={item.msg}
              isSelf={item.msg.sender === currentUserId}
              senderName={botNameByUserId.get(item.msg.sender)}
              allMessages={[...(messages ?? []), ...teamRoomMessages]}
            />
          );
        }
        return (
          <AgentStreamBubble
            key={item.stream.streamSessionId}
            stream={item.stream}
            senderName={botNameByUserId.get(item.stream.botUserId)}
          />
        );
      })}
    </div>
  );
}
