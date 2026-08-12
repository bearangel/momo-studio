// renderer/src/components/im/types.ts
//
// IM 组件共享类型定义。v1.7.4 新增 SegmentGroup 用于多段 task_complete
// 消息的归组渲染（重启后从 Matrix event 重建时按 segment_of 字段聚合）。

import type { ImMessage } from '../../ipc/types';

/**
 * 多段消息归组（task_complete 分段持久化的重启还原结构）。
 *
 * runtime 在 task_complete 分段时为每段 m.room.message event 写入：
 *   - io.momo-studio.segment_of: 原始 streamSessionId（归组 key）
 *   - io.momo-studio.segment_index: 段序号（1-based）
 *
 * MessageList 按 segment_of 字段把多段消息聚合为单个 SegmentGroup，
 * 交给 SegmentStack 组件纵向堆叠渲染。
 */
export interface SegmentGroup {
  /** 区分类型——mixedItems 数组里区分单消息与归组 */
  kind: 'segment-group';
  /** 归组 key（原始 streamSessionId，segment_of 字段的值） */
  streamSessionId: string;
  /** 段列表，按 segment_index 升序排序 */
  segments: ImMessage[];
  /** 最后一段的 timestamp（mixedItems 混合排序时用） */
  lastSegmentAt: number;
}
