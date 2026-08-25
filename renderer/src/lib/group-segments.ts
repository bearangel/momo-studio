// renderer/src/lib/group-segments.ts
//
// 按 segmentOf 字段把多段消息归组（v1.7.4 bug 2）。v2.0 U3 修复：group 必须
// 插入到其 anchor 的 chronological position，不允许全部追加到 standalone 末尾，
// 否则分段流期间穿插进入的用户消息会「被推到 segment 下方」，UI 时间序乱掉。
//
// anchor 策略：
//   - 首选：拥有匹配 streamSessionId 的「父消息」（其 streamSessionId === segment.groupId）
//     ——group 替换 anchor 在 list 中的位置，anchor 消息不独立渲染
//   - 兜底：anchor 缺失（历史片段没对应父消息），按 first segment createdAt
//     在 standalone 列表二分插入
//
// 返回 mixed items 数组，按时间穿插：单条 ImMessage 或 SegmentGroup（最后一段 ts 排序键）。
import type { ImMessage } from '../ipc/types';
import type { SegmentGroup } from '../components/im/types';

export type GroupedMessageItem = ImMessage | SegmentGroup;

/**
 * 按 segmentOf 归组多段消息，group 插入到 anchor 的时间位置。
 * 调用方负责过滤（dispatch / task_reply / parentStreamSessionId 等不参与归组）。
 */
export function groupBySegment(messages: ImMessage[]): GroupedMessageItem[] {
  // 1. 收集 segments（按 segmentOf key），并按 segmentIndex 升序排序
  const segmentsByStream = new Map<string, ImMessage[]>();
  for (const msg of messages) {
    if (typeof msg.segmentOf !== 'string') continue;
    const list = segmentsByStream.get(msg.segmentOf);
    if (list) {
      list.push(msg);
    } else {
      segmentsByStream.set(msg.segmentOf, [msg]);
    }
  }
  for (const list of segmentsByStream.values()) {
    list.sort((a, b) => (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0));
  }

  const result: GroupedMessageItem[] = [];
  // 已作为 anchor 处理过的 streamSessionId——避免第二轮 orphan 二次处理
  const anchoredStreamIds = new Set<string>();

  // 2. 第一遍：处理 standalone + anchor 命中 group（group 替换 anchor 位置）
  for (const msg of messages) {
    if (typeof msg.segmentOf === 'string') continue; // segment 由 group 承担，不独立 push
    const streamId = msg.streamSessionId;
    const segments = streamId ? segmentsByStream.get(streamId) : undefined;
    if (segments && streamId) {
      if (segments.length === 1) {
        // 单 segment 退化为独立消息——插在 anchor 原位置（语义与 group 等价）
        result.push(segments[0]!);
      } else {
        const last = segments[segments.length - 1]!;
        result.push({
          kind: 'segment-group',
          streamSessionId: streamId,
          segments,
          lastSegmentAt: last.createdAt,
        });
      }
      anchoredStreamIds.add(streamId);
    } else {
      result.push(msg);
    }
  }

  // 3. 第二遍：anchor 缺失的 orphan groups（历史纯片段，无对应父消息）
  //    按 first segment createdAt 二分插入到 standalone 时间序列
  for (const [streamId, segments] of segmentsByStream) {
    if (anchoredStreamIds.has(streamId)) continue;
    const firstAt = segments[0]!.createdAt;
    if (segments.length === 1) {
      insertByTs(result, segments[0]!, firstAt);
      continue;
    }
    const last = segments[segments.length - 1]!;
    const group: SegmentGroup = {
      kind: 'segment-group',
      streamSessionId: streamId,
      segments,
      lastSegmentAt: last.createdAt,
    };
    insertByTs(result, group, firstAt);
  }

  return result;
}

/** ImMessage / SegmentGroup 抽象排序键——混合排序时统一接口 */
function itTimestamp(item: ImMessage | SegmentGroup): number {
  if ('kind' in item) return item.lastSegmentAt;
  return item.createdAt;
}

/** 找到第一个时间戳大于 targetTs 的位置插入；找不到则尾部追加 */
function insertByTs(arr: GroupedMessageItem[], item: GroupedMessageItem, targetTs: number): void {
  let idx = arr.findIndex((it) => itTimestamp(it) > targetTs);
  if (idx === -1) idx = arr.length;
  arr.splice(idx, 0, item);
}
