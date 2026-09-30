// renderer/src/lib/turn-segment.ts
//
// 逐层撤回（turn undo）的「一组对话」界定（rollback UI 重设计 2026-09-28）：
// 一组 = 最后一条用户（sender === 'owner'）消息 + 其后全部 agent 消息行
// （含子 agent 嵌套流 / 分段 / roll 行，到下一条用户消息为止——按定义
// 「其后」天然不含更早组）。
//
// streamIds 归一：消息行的 streamSessionId 可能带 `#roll{n}` / `#seg` 后缀
// （DB 侧续流行族），而 journal 条目记录 runtime 发出的 base ssi——剥 `#`
// 后缀归一到 base，组内条目匹配才不漏。

import type { ImMessage } from '../ipc/types';

export interface TurnSegment {
  /** 触发本组的用户消息 id */
  ownerMessageId: string;
  /** 本组全部消息行 id（owner + 其后 agent 行），删除面 */
  messageIds: string[];
  /** 本组 agent 行的 base streamSessionId 集合（剥 # 后缀去重），账本匹配面 */
  streamIds: string[];
}

/**
 * 取消息列表的最后一组对话。无用户消息（纯 agent 会话）返回 null——
 * 无可撤组（用户提问是组的锚点，没有锚点不构成「一组对话」）。
 */
export function latestTurn(messages: ImMessage[]): TurnSegment | null {
  let lastOwnerIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.sender === 'owner') {
      lastOwnerIdx = i;
      break;
    }
  }
  if (lastOwnerIdx === -1) return null;

  const owner = messages[lastOwnerIdx]!;
  const rest = messages.slice(lastOwnerIdx + 1);
  const streamIds = new Set<string>();
  for (const m of rest) {
    if (m.streamSessionId !== null) streamIds.add(m.streamSessionId.split('#')[0]!);
  }
  return {
    ownerMessageId: owner.id,
    messageIds: [owner.id, ...rest.map((m) => m.id)],
    streamIds: [...streamIds],
  };
}
