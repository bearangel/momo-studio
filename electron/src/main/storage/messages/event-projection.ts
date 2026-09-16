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
