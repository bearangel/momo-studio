//
// 本地 sender 语义（spec 2026-10-13 §5.1）：'owner'=本机用户 / 'system'=系统生成行
// （dispatch 回执、followup 追问）/ 'agent-*'=agent 实例。
// （p2p 'remote:<node>' 远端形态已随 P2P 子系统于 2026-10-20 移除）
export type LocalSender = 'owner' | 'system' | `agent-${string}`;

/** 是否系统生成行（渲染为系统事件卡，非用户/agent 气泡） */
export function isSystemSender(sender: string): boolean {
  return sender === 'system';
}

/** 是否回合锚点（owner 用户消息或 system 系统行——turn-segment 撤回组锚点口径） */
export function isTurnAnchor(sender: string): boolean {
  return sender === 'owner' || sender === 'system';
}
