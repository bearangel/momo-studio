// electron/src/main/storage/messages/event-projection.ts
//
// 事件行 egress 投影（v2.11 终审 I2）：DB 事件行 → renderer 线载荷的单点投影。
// steer 事件 payload.context（ExpandedContext 全文：skill 正文 + 文件内容）只
// 保留在 DB——resume 断点重建经 turn-reconstructor 直读重放（I1）；两处
// renderer 出口（event-buffer flush 推送 session:message_event_batch、
// getMessages / loadOlder 的 eventsByMessage）一律剥离，防全文随每条 steer
// 事件回流 renderer（体积放大 + 暴露面扩大）。两出口共用本投影防契约漂移。
import type { MessageEventRow } from './events-repo';

/** 单行投影：steer 事件剥离 payload.context；其余事件原样透传（零拷贝） */
export function projectEventForWire(ev: MessageEventRow): MessageEventRow {
  if (ev.eventType !== 'steer') return ev;
  if (typeof ev.payload !== 'object' || ev.payload === null || !('context' in ev.payload)) {
    return ev;
  }
  // 浅拷贝剥离——不动来源对象（onFlush 的 pending 行与 repo 查询行共用本函数）
  const { context: _stripped, ...rest } = ev.payload;
  return { ...ev, payload: rest };
}

/** 批量投影（两处 egress 统一入口） */
export function projectEventsForWire(events: MessageEventRow[]): MessageEventRow[] {
  return events.map(projectEventForWire);
}

// ============================================================================
// thinking wire 截断（2026-10-14 会话切换延迟修复 P0-2）
//
// 真机剖析：spring-mcp 表面 103 条消息 / 200KB，底下 message_events 39.5 万行
// / 10.4MB——其中 thinking 全文 ≈ 4.8MB。压缩快照只合并行数（delta 游程合并），
// 字节量原样保留，切换会话时全量跨 IPC。折叠态 UI 只需预览文本，全量 thinking
// 在用户展开时按需拉取（session:getMessageThinking）。
//
// 契约（两端同 commit，见 stream-aggregator / stream.store.expandThinking）：
// - 只对终态消息截断（final/status_change ∈ done|failed|aborted）——流式消息
//   的实时 thinking 不动（live 推送路径 stream-relay 不经过本截断）
// - 截断 = 保留前 THINKING_WIRE_BUDGET 字符的 thinking 游程，丢弃其余，并在
//   末尾追加合成 marker 事件 thinking_truncated（seq=THINKING_TRUNCATED_SEQ，
//   携带全量字符数）——renderer 聚合出 thinkingTruncated 标志
// - marker 与真实事件永不 seq 碰撞：真实 seq 由 DB 计数器分配（小整数递增）
// ============================================================================

/** 终态消息 thinking 的 wire 预算（字符）——折叠态预览足够，展开走按需拉取 */
export const THINKING_WIRE_BUDGET = 2000;

/** 合成 marker 的 seq——远离 DB 计数器分配的真实 seq 空间 */
export const THINKING_TRUNCATED_SEQ = 1_000_000_000;

/** 终态判定：与 renderer aggregateEvents 的 status 收敛口径一致（旧形状 final 无 status = done） */
function isTerminal(events: MessageEventRow[]): boolean {
  for (const ev of events) {
    if (ev.eventType === 'final') {
      if (ev.payload.status === 'streaming') continue;
      return true;
    }
    if (
      ev.eventType === 'status_change' &&
      (ev.payload.status === 'done' || ev.payload.status === 'failed' || ev.payload.status === 'aborted')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 历史加载路径的 thinking 截断（buildEventsByMessage 专用；live flush 不走）。
 * 输入须已过 projectEventsForWire（steer 剥离先行，顺序无关但保持单一入口习惯）。
 */
export function truncateThinkingForWire(events: MessageEventRow[]): MessageEventRow[] {
  if (!isTerminal(events)) return events;
  let budget = THINKING_WIRE_BUDGET;
  let totalChars = 0;
  let truncated = false;
  const out: MessageEventRow[] = [];
  for (const ev of events) {
    if (ev.eventType === 'thinking_delta' && typeof ev.payload.delta === 'string') {
      totalChars += ev.payload.delta.length;
      if (truncated) continue; // 预算耗尽：丢弃后续 thinking 游程
      if (ev.payload.delta.length > budget) {
        out.push({ ...ev, payload: { ...ev.payload, delta: ev.payload.delta.slice(0, budget) } });
        budget = 0;
        truncated = true;
      } else {
        out.push(ev);
        budget -= ev.payload.delta.length;
      }
      continue;
    }
    out.push(ev);
  }
  if (!truncated) return events; // 未截断：原引用返回（零拷贝快路径）
  out.push({
    id: 'wire-thinking-truncated',
    messageId: events[0]?.messageId ?? '',
    seq: THINKING_TRUNCATED_SEQ,
    eventType: 'thinking_truncated',
    payload: { fullChars: totalChars },
    createdAt: out[out.length - 1]?.createdAt ?? 0,
  });
  return out;
}

// ============================================================================
// tool_call_result wire 截断（2026-10-14 会话切换延迟修复 · 第二刀）
//
// 真机度量：thinking 截断后剩余 wire ≈ 2.8MB，其中 tool 结果（bash 输出 / 文件
// 读取，单条可达几十 KB）≈ 2.4MB——而 ToolCallChip 默认折叠只显示摘要行。
//
// 与 thinking 的形态差异 → 截断机制不同（无 marker 事件）：
// - thinking 是追加式文本流（预算跨游程、尾部整段丢弃）→ 必须末尾 marker
// - tool 结果是离散自包含值 → 截断标志直接内嵌 payload：
//   { callId, result: '<预览>', success, truncated: true, fullLength: N }
// - renderer 聚合读 p.truncated 置段级标志；展开时按 seq 整事件替换（新事件
//   无 truncated 键）→ 重聚合标志自然消失；success 等兄弟字段在替换时保留
// ============================================================================

/** 终态消息单条工具结果的 wire 预算（字符）——折叠态摘要 + 10 行预览足够 */
export const TOOL_RESULT_WIRE_BUDGET = 800;

/** tool_call_result wire 截断（与 thinking 截断同门：仅历史加载路径） */
export function truncateToolResultsForWire(events: MessageEventRow[]): MessageEventRow[] {
  if (!isTerminal(events)) return events;
  let out: MessageEventRow[] | null = null; // null = 未发生任何截断（零拷贝快路径）
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.eventType !== 'tool_call_result' || typeof ev.payload.result !== 'string') continue;
    if (ev.payload.result.length <= TOOL_RESULT_WIRE_BUDGET) continue;
    if (out === null) out = events.slice(0, i);
    out.push({
      ...ev,
      payload: {
        ...ev.payload,
        result: ev.payload.result.slice(0, TOOL_RESULT_WIRE_BUDGET),
        truncated: true,
        fullLength: ev.payload.result.length,
      },
    });
  }
  return out ?? events;
}
