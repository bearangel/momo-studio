// electron/src/main/files/ipc.handlers.ts
//
// 文件读写 IPC handlers — 把 T5 的 WorkspaceFS 包装成 `file:read` /
// `file:write` / `file:list` 三个 IPC 通道。每个 workspace 缓存一份
// WorkspaceFS 实例，避免每次 IPC 调用都重建。
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { WorkspaceFS } from './workspace-fs';
import { getWorkspace } from '../workspace/crud';

/** 缓存每个 workspace 的 WorkspaceFS 实例。 */
export const fsCache = new Map<string, WorkspaceFS>();

function getWorkspaceFs(workspaceId: string): WorkspaceFS {
  const cached = fsCache.get(workspaceId);
  if (cached) return cached;

  const ws = getWorkspace(workspaceId);
  if (!ws) throw new Error(`Workspace 不存在: ${workspaceId}`);

  const wsFs = new WorkspaceFS(ws.directoryPath);
  fsCache.set(workspaceId, wsFs);
  return wsFs;
}

/** 仅供测试使用：在每个用例前清空缓存，避免跨用例复用旧 WorkspaceFS 实例。 */
export function __resetFsCacheForTest(): void {
  fsCache.clear();
}

/** 注册 file:* IPC handlers。重复注册会被 Electron 拒绝，故仅调用一次。 */
export function registerFileHandlers(): void {
  ipcMain.handle('file:read', async (_evt, workspaceId: string, filePath: string) => {
    const wsFs = getWorkspaceFs(workspaceId);
    const buf = await wsFs.readFile(filePath);
    return buf.toString('utf-8');
  });

  ipcMain.handle(
    'file:write',
    async (_evt, workspaceId: string, filePath: string, content: string) => {
      const wsFs = getWorkspaceFs(workspaceId);
      await wsFs.writeFile(filePath, content);
      logger.info('文件已写入', { workspaceId, filePath });
    },
  );

  ipcMain.handle('file:list', async (_evt, workspaceId: string, dirPath: string) => {
    const wsFs = getWorkspaceFs(workspaceId);
    return wsFs.listDir(dirPath);
  });

  logger.info('File IPC handlers 已注册');
}
