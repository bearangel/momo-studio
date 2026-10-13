// electron/src/main/ipc/index.ts
import { BrowserWindow } from 'electron';
import { logger } from '../logger';
import { registerSystemHandlers } from './system.handlers';
import { registerWorkspaceHandlers } from '../workspace/ipc.handlers';
import { registerFileHandlers } from '../files/ipc.handlers';
import { registerAssetHandlers } from '../files/asset-ipc';
import { registerAssetReadHandlers } from '../files/asset-read-ipc';
import { registerAgentHandlers } from '../agent/ipc.handlers';
import { registerStreamIpc } from '../agent/stream-relay';
// 三级中断四通道（spec 2026-10-13 §7.2）：RouterService 级联 + registry 在途查询
import { registerInterruptIpc } from '../agent/interrupt-ipc';
import { getRouterService } from '../agent/router-bootstrap';
// P2-D Task D1：listInFlight 数据面（registry 在途链 → 视图 + 子 agent 名解析）
import { listInFlightViews } from '../agent/inflight-view';
import { registerSessionIpcHandlers } from '../im/session.ipc.handlers';
import { registerMcpHandlers } from '../mcp/ipc.handlers';
import { registerAllocationHandlers } from '../workspace/ipc.handlers';
import { registerGitPolicyHandlers } from '../workspace/git-policy';
import { registerAuditHandlers } from '../audit/ipc.handlers';
import { registerProviderHandlers } from '../agent/provider-ipc';
import { registerSettingsIpc } from '../settings/ipc.handlers';
// 多语言 LSP 子系统（2026-10-01）：面板语言状态查询 / 重探测 invoke
import { registerLspPanelIpc } from '../lsp/ipc';
import { registerSandboxIpc } from '../sandbox/ipc.handlers';
import { registerMemoryIpc } from '../memory/ipc.handlers';
import { registerJournalIpc } from '../journal/ipc.handlers';
import { registerResourceHandlers } from '../resource/ipc.handlers';
import { registerTaskHandlers } from '../task/ipc.handlers';
import { registerTaskGroupHandlers } from '../task/groups.ipc.handlers';
import { registerP2pHandlers } from '../p2p';
import { registerDialogHandlers } from './dialog.handlers';
import { registerWindowIpc } from '../window-ipc';
// 新装引导（spec 2026-10-10）：status / 方案生成 / 方案应用 / 完成标记
import { registerOnboardingHandlers } from '../onboarding/ipc.handlers';
import type { WorkspaceIpcOpts } from '../workspace/ipc.handlers';

/**
 * 注册全部 IPC handlers（app ready 后调用一次）。
 * opts 目前仅透传 workspace:* 的跨子系统回调（v2.7 T10 workspace:switch → 浏览器子系统）。
 */
export function registerIpcHandlers(opts: WorkspaceIpcOpts = {}): void {
  logger.info('Registering IPC handlers');
  registerSystemHandlers();
  registerWorkspaceHandlers(opts);
  registerFileHandlers();
  // 2026-09-26 多模态：asset:saveImage（粘贴/拖入降采样图片内容寻址落盘，spec §5）
  registerAssetHandlers();
  // 2026-09-26 多模态：asset:readDataUrl（气泡缩略图读图，spec §10；与 saveImage 同址接线）
  registerAssetReadHandlers();
  registerAgentHandlers();
  registerStreamIpc();
// 三级中断四通道（spec 2026-10-13 §7.2）：注册先于 RouterService lazy 启动
//（main/index.ts 中 initTaskDrivenRuntime 在 registerIpcHandlers 之后），故
// abortTurn/stopAll/cancelChain 于 invoke 时刻经 getRouterService 解析单例——
// 未启动 = 无在途流/链，幂等空结果（与 abortStreamBySessionId 未注入 resolver
// 返回 false 同语义）。listInFlight 走 inflight-view 真实现（P2-D Task D1）：
// registry 在途链 + 主进程解析子 agent 展示名（成员已删/DB 异常降级 null）。
  registerInterruptIpc({
    abortTurn: (sessionId) =>
      getRouterService()?.abortTurn(sessionId) ?? { stoppedStream: false },
    stopAll: (sessionId) =>
      getRouterService()?.stopAll(sessionId) ?? { stoppedStreams: 0, cancelledChains: 0 },
    cancelChain: (arg) => getRouterService()?.cancelChain(arg) ?? { status: 'not_found' },
    listInFlight: listInFlightViews,
  });
  registerSessionIpcHandlers();
  registerMcpHandlers();
  registerAllocationHandlers();
  registerGitPolicyHandlers();
  registerAuditHandlers();
  registerProviderHandlers();
  registerSettingsIpc();
  // 多语言 LSP 子系统（2026-10-01）：lsp:status / lsp:redetect（与 settings 面板同址接线）
  registerLspPanelIpc();
  registerSandboxIpc();
  registerMemoryIpc();
  // v2.5：变更账本通道（journal/ipc.handlers.ts）——list / revert / scan / 组合回滚
  registerJournalIpc();
  registerResourceHandlers();
  registerTaskHandlers();
  // 看板重构 Task 7：taskGroup 命名空间（组 CRUD + 归档级联 + abort 补偿）
  registerTaskGroupHandlers();
  registerP2pHandlers();
  registerDialogHandlers();
  // 新装引导（spec 2026-10-10）
  registerOnboardingHandlers();
  // 窗口控制（自绘 titlebar）——注册先于窗口创建，getWin 每次调用时懒查首个窗口
  registerWindowIpc(() => BrowserWindow.getAllWindows()[0] ?? null);
}
