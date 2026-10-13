//
// UI sender → LLM role 单点映射（spec 2026-10-13 §5.4）：
// 'owner' / 'system' / 'remote:*' / 未知 → user（保守降级）；
// 'agent-*' → assistant。会话重建（turn-reconstructor）与链历史重建
// （sub-history-reconstructor）共用——模型视角与 UI 视角解耦的单一真相源。
export function mapsToUserRole(sender: string): boolean {
  return !sender.startsWith('agent-');
}
