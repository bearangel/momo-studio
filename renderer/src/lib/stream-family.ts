//
// 流族工具调用计数（spec 2026-10-13 §8.1）：own = base ssi 全族（含 #roll 换行行）
// 的 toolCalls 之和；sub = 直接子链（parentStreamSessionId ∈ 本族）之和。
// #seg 分段行是 body 快照（事件挂父行）——排除防双计。streams 无条目的行按 0 计
// （历史裁剪降级，不伪造合计）。
import type { ImMessage } from '../ipc/types';

export function baseSsi(streamSessionId: string): string {
  return streamSessionId.split('#')[0]!;
}

export function countFamilyToolCalls(
  messages: ImMessage[],
  streams: Map<string, { toolCalls: unknown[] }>,
  ownStreamSessionId: string,
): { own: number; sub: number } {
  const ownBase = baseSsi(ownStreamSessionId);
  const ownBases = new Set([ownBase]);
  // roll 族成员先收集（族 = base 相同的流行），子链归属也按族判定
  for (const m of messages) {
    if (m.segmentOf !== null) continue;
    if (m.parentStreamSessionId !== null) continue;
    if (m.streamSessionId !== null && baseSsi(m.streamSessionId) === ownBase) ownBases.add(baseSsi(m.streamSessionId));
  }
  const inFamily = (ssi: string | null): boolean => ssi !== null && ownBases.has(baseSsi(ssi));
  const countOf = (id: string): number => streams.get(id)?.toolCalls.length ?? 0;

  let own = 0;
  let sub = 0;
  for (const m of messages) {
    if (m.segmentOf !== null) continue; // 分段行快照，防双计
    if (m.parentStreamSessionId === null) {
      if (inFamily(m.streamSessionId)) own += countOf(m.id);
    } else if (inFamily(m.parentStreamSessionId)) {
      sub += countOf(m.id); // 直接子链（孙代 parent=子流，不属本族）
    }
  }
  return { own, sub };
}
