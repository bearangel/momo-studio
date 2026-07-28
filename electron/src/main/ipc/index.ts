// electron/src/main/ipc/index.ts
import { logger } from '../logger';
import { registerAuthHandlers } from './auth.handlers';
import { registerSystemHandlers } from './system.handlers';
import { registerWorkspaceHandlers } from '../workspace/ipc.handlers';
import { registerFileHandlers } from '../files/ipc.handlers';
import { registerAgentHandlers } from '../agent/ipc.handlers';
import { registerImHandlers } from '../im/ipc.handlers';
import { registerMcpHandlers } from '../mcp/ipc.handlers';
import { registerAllocationHandlers } from '../workspace/ipc.handlers';
import { registerGitPolicyHandlers } from '../workspace/git-policy';
import { registerAuditHandlers } from '../audit/ipc.handlers';

export function registerIpcHandlers(): void {
  logger.info('Registering IPC handlers');
  registerAuthHandlers();
  registerSystemHandlers();
  registerWorkspaceHandlers();
  registerFileHandlers();
  registerAgentHandlers();
  registerImHandlers();
  registerMcpHandlers();
  registerAllocationHandlers();
  registerGitPolicyHandlers();
  registerAuditHandlers();
}
