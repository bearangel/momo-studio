// electron/src/main/ipc/index.ts
import { logger } from '../logger';
import { registerAuthHandlers } from './auth.handlers';
import { registerSystemHandlers } from './system.handlers';
import { registerWorkspaceHandlers } from '../workspace/ipc.handlers';

export function registerIpcHandlers(): void {
  logger.info('Registering IPC handlers');
  registerAuthHandlers();
  registerSystemHandlers();
  registerWorkspaceHandlers();
}
