// renderer/src/lib/group-tool-segments.ts
//
// 渲染前分段分组（纯渲染层，聚合器零改动）：连续 ≥2 个只读工具段合并为
// context-group（「收集上下文 · N 次读取 · M 次搜索」）；todowrite 段过滤
// （TodoSection 已展示，双份冗余）。AgentStreamBubble / SubAgentSection 共用。
import type { StreamSegment } from './stream-aggregator';

/** 只读「收集上下文」类工具——合并展示不打断阅读 */
const CONTEXT_TOOLS = new Set(['read_file', 'glob', 'grep', 'list_files']);

/** 不再单独渲染 chip 的工具（已有专属展示区） */
const HIDDEN_TOOLS = new Set(['todowrite']);

type ToolSeg = Extract<StreamSegment, { kind: 'tool_call' }>;

/** 连续只读工具的合并块，供 ContextGroupChip 消费 */
export interface ContextGroup {
  kind: 'context-group';
  items: ToolSeg[];
}

/** 渲染层分段：原始段或合并后的 context-group */
export type RenderSegment = StreamSegment | ContextGroup;

/**
 * 把 stream-aggregator 产出的线性分段再做一次渲染层分组：
 * - 连续 ≥2 个只读工具合并为单个 context-group
 * - 单个只读工具保留独立 tool_call（不值得为一项做合并）
 * - 非只读工具立即 flush 缓冲区并自身透传（打断连续段）
 * - todowrite 直接过滤（TodoSection 已展示，避免双份冗余）
 * - thinking / text / dispatch 等非 tool_call 段按出现顺序透传
 */
export function groupToolSegments(segments: StreamSegment[]): RenderSegment[] {
  const out: RenderSegment[] = [];
  let buf: ToolSeg[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    if (buf.length === 1) {
      // 单个只读工具不合并，照旧独立 tool_call
      out.push(buf[0]!);
    } else {
      out.push({ kind: 'context-group', items: buf });
    }
    buf = [];
  };
  for (const seg of segments) {
    if (seg.kind === 'tool_call' && HIDDEN_TOOLS.has(seg.toolName)) {
      // todowrite 等已由专属组件展示的过滤掉
      continue;
    }
    if (seg.kind === 'tool_call' && CONTEXT_TOOLS.has(seg.toolName)) {
      buf.push(seg);
      continue;
    }
    // 非只读工具立即 flush 缓冲区，再把当前段透传
    flush();
    out.push(seg);
  }
  // 末尾 flush 兜底：保证收尾的连续只读段也被合并
  flush();
  return out;
}
