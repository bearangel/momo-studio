// renderer/src/components/im/__tests__/MessageList.segment.test.ts
//
// v1.7.4 Bug 2 测试：MessageList 的 groupBySegment 函数（纯逻辑测试）。
// 不渲染整个 MessageList 组件（依赖 store 太多），直接测归组算法。

import { describe, it, expect } from 'vitest';
import type { ImMessage } from '../../../ipc/types';
import type { SegmentGroup } from '../types';

// 复制 MessageList.tsx 内的 groupBySegment 函数（保持算法一致）
function groupBySegment(messages: ImMessage[]): Array<ImMessage | SegmentGroup> {
  const segmentMap = new Map<string, ImMessage[]>();
  const standalone: ImMessage[] = [];

  for (const msg of messages) {
    const segmentOf = msg.content?.['io.momo-studio.segment_of'];
    if (typeof segmentOf === 'string') {
      if (!segmentMap.has(segmentOf)) segmentMap.set(segmentOf, []);
      segmentMap.get(segmentOf)!.push(msg);
    } else {
      standalone.push(msg);
    }
  }

  const result: Array<ImMessage | SegmentGroup> = [...standalone];
  for (const [streamSessionId, segments] of segmentMap) {
    segments.sort((a, b) => {
      const ai = (a.content?.['io.momo-studio.segment_index'] as number) ?? 0;
      const bi = (b.content?.['io.momo-studio.segment_index'] as number) ?? 0;
      return ai - bi;
    });
    if (segments.length === 1) {
      const only = segments[0];
      if (only) result.push(only);
    } else if (segments.length > 1) {
      const last = segments[segments.length - 1];
      result.push({
        kind: 'segment-group',
        streamSessionId,
        segments,
        lastSegmentAt: last ? last.timestamp : Date.now(),
      });
    }
  }
  return result;
}

const mkMsg = (
  eventId: string,
  segmentOf: string | undefined,
  segmentIndex: number | undefined,
  ts: number,
): ImMessage => ({
  eventId,
  roomId: 'r1',
  sender: '@bot:localhost',
  body: `msg-${eventId}`,
  eventType: 'm.room.message',
  timestamp: ts,
  content: {
    body: `msg-${eventId}`,
    ...(segmentOf ? { 'io.momo-studio.segment_of': segmentOf } : {}),
    ...(segmentIndex !== undefined ? { 'io.momo-studio.segment_index': segmentIndex } : {}),
  },
});

describe('MessageList groupBySegment 归组逻辑', () => {
  it('无 segment_of 的消息保持独立', () => {
    const msgs = [
      mkMsg('e1', undefined, undefined, 100),
      mkMsg('e2', undefined, undefined, 200),
    ];
    const result = groupBySegment(msgs);
    expect(result.length).toBe(2);
    expect('eventId' in result[0]! && result[0].eventId).toBe('e1');
    expect('eventId' in result[1]! && result[1].eventId).toBe('e2');
  });

  it('多段 segment_of 相同的消息归为一组', () => {
    const msgs = [
      mkMsg('e1', 'session-1', 1, 100),
      mkMsg('e2', 'session-1', 2, 200),
      mkMsg('e3', 'session-1', 3, 300),
    ];
    const result = groupBySegment(msgs);
    expect(result.length).toBe(1);
    const group = result[0];
    expect(group && 'kind' in group && group.kind).toBe('segment-group');
    if (group && 'kind' in group && group.kind === 'segment-group') {
      expect(group.segments.length).toBe(3);
      expect(group.lastSegmentAt).toBe(300);
      expect(group.streamSessionId).toBe('session-1');
    }
  });

  it('段顺序按 segment_index 升序（即使输入乱序）', () => {
    const msgs = [
      mkMsg('e3', 's', 3, 300),
      mkMsg('e1', 's', 1, 100),
      mkMsg('e2', 's', 2, 200),
    ];
    const result = groupBySegment(msgs);
    const group = result[0];
    if (group && 'kind' in group && group.kind === 'segment-group') {
      expect(group.segments.map((s) => s.eventId)).toEqual(['e1', 'e2', 'e3']);
    }
  });

  it('单段消息（有 segment_of 但只 1 条）不归组', () => {
    const msgs = [mkMsg('e1', 'sess', 1, 100)];
    const result = groupBySegment(msgs);
    expect(result.length).toBe(1);
    expect('eventId' in result[0]! && result[0].eventId).toBe('e1');
  });

  it('混合场景：独立消息 + 多段归组 + 单段独立', () => {
    const msgs = [
      mkMsg('user1', undefined, undefined, 50),
      mkMsg('seg1-1', 'sess-a', 1, 100),
      mkMsg('seg1-2', 'sess-a', 2, 150),
      mkMsg('single', 'sess-b', 1, 200),
      mkMsg('user2', undefined, undefined, 250),
    ];
    const result = groupBySegment(msgs);
    // 期望：3 个独立（user1, single, user2）+ 1 个归组（sess-a 含 2 段）
    expect(result.length).toBe(4);
    const groups = result.filter((r) => 'kind' in r && r.kind === 'segment-group');
    const standalones = result.filter((r) => 'eventId' in r);
    expect(groups.length).toBe(1);
    expect(standalones.length).toBe(3);
  });
});
