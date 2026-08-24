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
import { registerResourceHandlers } from '../resource/ipc.handlers';
import { registerTaskHandlers } from '../task/ipc.handlers';
import { registerP2pHandlers } from '../p2p';
import { registerDialogHandlers } from './dialog.handlers';
import { registerWindowIpc } from '../window-ipc';

export function registerIpcHandlers(): void {
  logger.info('Registering IPC handlers');
  registerSystemHandlers();
  registerWorkspaceHandlers();
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
  registerResourceHandlers();
  registerTaskHandlers();
  registerP2pHandlers();
  registerDialogHandlers();
  // 窗口控制（自绘 titlebar）——注册先于窗口创建，getWin 每次调用时懒查首个窗口
  registerWindowIpc(() => BrowserWindow.getAllWindows()[0] ?? null);
}
