// renderer/src/lib/group-segments.test.ts
//
// U3 回归锁：分段消息组必须插入 anchor 的时间位置，不允许整体追加到
// standalone 末尾——否则分段流期间穿插的用户消息会被「推到 segment 下方」，
// UI 时间序错乱。
import { describe, it, expect } from 'vitest';
import { groupBySegment } from './group-segments';
import type { ImMessage } from '../ipc/types';

function makeMsg(overrides: Partial<ImMessage> & Pick<ImMessage, 'id'>): ImMessage {
  return {
    sessionId: 's1',
    sender: 'owner',
    body: '',
    eventType: 'message',
    streamSessionId: null,
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'done',
    source: 'local',
    workspaceId: null,
    taskId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('groupBySegment 时间序归并（U3）', () => {
  it('group 替换 anchor 位置：[A, parent, B] 中分段组渲染在 A 与 B 之间', () => {
    const parent = makeMsg({ id: 'p', streamSessionId: 'stream-1', createdAt: 200 });
    const items = [
      makeMsg({ id: 'a', createdAt: 100 }),
      parent,
      makeMsg({ id: 'b', createdAt: 300 }),
      makeMsg({ id: 'seg1', segmentOf: 'stream-1', segmentIndex: 0, createdAt: 210 }),
      makeMsg({ id: 'seg2', segmentOf: 'stream-1', segmentIndex: 1, createdAt: 220 }),
    ];
    const result = groupBySegment(items);
    expect(result).toHaveLength(3);
    expect((result[0] as ImMessage).id).toBe('a');
    expect(result[1]!.kind).toBe('segment-group');
    expect((result[1] as { segments: ImMessage[] }).segments.map((s) => s.id)).toEqual([
      'seg1',
      'seg2',
    ]);
    expect((result[2] as ImMessage).id).toBe('b');
  });

  it('orphan 分段（anchor 缺失）按首段 createdAt 插入时间序列，不追加尾部', () => {
    const items = [
      makeMsg({ id: 'early', createdAt: 100 }),
      makeMsg({ id: 'late', createdAt: 300 }),
      makeMsg({ id: 'seg1', segmentOf: 'orphan-stream', segmentIndex: 0, createdAt: 150 }),
      makeMsg({ id: 'seg2', segmentOf: 'orphan-stream', segmentIndex: 1, createdAt: 160 }),
    ];
    const result = groupBySegment(items);
    expect(result).toHaveLength(3);
    expect((result[0] as ImMessage).id).toBe('early');
    expect(result[1]!.kind).toBe('segment-group');
    expect((result[2] as ImMessage).id).toBe('late');
  });

  it('单 segment 退化为独立消息，插在 anchor 原位置', () => {
    const items = [
      makeMsg({ id: 'a', createdAt: 100 }),
      makeMsg({ id: 'p', streamSessionId: 'solo', createdAt: 200 }),
      makeMsg({ id: 'seg', segmentOf: 'solo', segmentIndex: 0, createdAt: 210 }),
      makeMsg({ id: 'b', createdAt: 300 }),
    ];
    const result = groupBySegment(items);
    expect(result).toHaveLength(3);
    expect((result[1] as ImMessage).id).toBe('seg');
    // 无 group 产物——全部是独立消息
    expect(result.every((it) => !('kind' in it))).toBe(true);
  });

  it('无分段消息时原样返回', () => {
    const items = [makeMsg({ id: 'a', createdAt: 1 }), makeMsg({ id: 'b', createdAt: 2 })];
    expect(groupBySegment(items).map((it) => (it as ImMessage).id)).toEqual(['a', 'b']);
  });
});
