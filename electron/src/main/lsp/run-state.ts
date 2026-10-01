// LSP 运行状态（spec §9）——经 manager 单例表实装三态查询：
//   stopped（无实例 / 未启动）→ idle（已启动且 60s 无活动）→ running。
// 消费方：detect.ts（lsp:status 面板）与 Task 4 IPC；manager.ts 转发导出本模块。
import { getLspManager } from './manager';

export type LspRunState = 'running' | 'idle' | 'stopped';

export function getLspRunState(workspaceId: string, languageId: string): LspRunState {
  const m = getLspManager(workspaceId, languageId);
  if (!m || !m.isStarted()) return 'stopped';
  return m.isIdle() ? 'idle' : 'running';
}
