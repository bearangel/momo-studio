// renderer/src/lib/turn-segment.ts
//
// 逐层撤回（turn undo）的「一组对话」界定（rollback UI 重设计 2026-09-28；
// 锚点扩展 spec 2026-10-13 §5.3）：
// 一组 = 最后一个锚点行（isTurnAnchor：owner 用户消息或 system 系统行）+
// 其后全部 agent 消息行（含子 agent 嵌套流 / 分段 / roll 行，到下一个锚点
// 为止——按定义「其后」天然不含更早组）。system 回执行（dispatch 送达 /
// followup 追问）作为锚点自成一组，撤回回执唤醒的回合不连带更早提问。
//
// streamIds 归一：消息行的 streamSessionId 可能带 `#roll{n}` / `#seg` 后缀
// （DB 侧续流行族），而 journal 条目记录 runtime 发出的 base ssi——剥 `#`
// 后缀归一到 base，组内条目匹配才不漏。

import type { ImMessage } from '../ipc/types';
import { isTurnAnchor } from './sender';

export interface TurnSegment {
  /** 触发本组的锚点行 id（owner 用户消息或 system 系统行） */
  anchorMessageId: string;
  /** 本组全部消息行 id（锚点 + 其后 agent 行），删除面 */
  messageIds: string[];
  /** 本组 agent 行的 base streamSessionId 集合（剥 # 后缀去重），账本匹配面 */
  streamIds: string[];
}

/**
 * 取消息列表的最后一组对话。无锚点（纯 agent 会话，既无用户消息也无系统行）
 * 返回 null——无可撤组（锚点是组的起点，没有锚点不构成「一组对话」）。
 */
export function latestTurn(messages: ImMessage[]): TurnSegment | null {
  let anchorIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isTurnAnchor(messages[i]!.sender)) {
      anchorIdx = i;
      break;
    }
  }
  if (anchorIdx === -1) return null;

  const anchor = messages[anchorIdx]!;
  const rest = messages.slice(anchorIdx + 1);
  const streamIds = new Set<string>();
  for (const m of rest) {
    if (m.streamSessionId !== null) streamIds.add(m.streamSessionId.split('#')[0]!);
  }
  return {
    anchorMessageId: anchor.id,
    messageIds: [anchor.id, ...rest.map((m) => m.id)],
    streamIds: [...streamIds],
  };
}
