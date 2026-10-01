// LSP 运行状态（spec §9）——Task 3 由 manager 实装替换本桩。
// 当前桩：恒返回 'stopped'，使面板与 spawn 注入在 Task 3 落地前行为一致。
export type LspRunState = 'running' | 'idle' | 'stopped';

export function getLspRunState(_workspaceId: string, _languageId: string): LspRunState {
  return 'stopped';
}