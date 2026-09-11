// electron/src/main/ipc/index.ts
import { BrowserWindow } from 'electron';
import { logger } from '../logger';
import { registerSystemHandlers } from './system.handlers';
import { registerWorkspaceHandlers } from '../workspace/ipc.handlers';
import { registerFileHandlers } from '../files/ipc.handlers';
import { registerAgentHandlers } from '../agent/ipc.handlers';
import { registerStreamIpc } from '../agent/stream-relay';
import { registerSessionIpcHandlers } from '../im/session.ipc.handlers';
import { registerMcpHandlers } from '../mcp/ipc.handlers';
import { registerAllocationHandlers } from '../workspace/ipc.handlers';
import { registerGitPolicyHandlers } from '../workspace/git-policy';
import { registerAuditHandlers } from '../audit/ipc.handlers';
import { registerProviderHandlers } from '../agent/provider-ipc';
import { registerSettingsIpc } from '../settings/ipc.handlers';
import { registerSandboxIpc } from '../sandbox/ipc.handlers';
import { registerMemoryIpc } from '../memory/ipc.handlers';
import { registerJournalIpc } from '../journal/ipc.handlers';
import { registerResourceHandlers } from '../resource/ipc.handlers';
import { registerTaskHandlers } from '../task/ipc.handlers';
import { registerP2pHandlers } from '../p2p';
import { registerDialogHandlers } from './dialog.handlers';
import { registerWindowIpc } from '../window-ipc';
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
  registerAgentHandlers();
  registerStreamIpc();
  registerSessionIpcHandlers();
  registerMcpHandlers();
  registerAllocationHandlers();
  registerGitPolicyHandlers();
  registerAuditHandlers();
  registerProviderHandlers();
  registerSettingsIpc();
  registerSandboxIpc();
  registerMemoryIpc();
  // v2.5：变更账本通道（journal/ipc.handlers.ts）——list / revert / scan / 组合回滚
  registerJournalIpc();
  registerResourceHandlers();
  registerTaskHandlers();
  registerP2pHandlers();
  registerDialogHandlers();
  // 窗口控制（自绘 titlebar）——注册先于窗口创建，getWin 每次调用时懒查首个窗口
  registerWindowIpc(() => BrowserWindow.getAllWindows()[0] ?? null);
}
