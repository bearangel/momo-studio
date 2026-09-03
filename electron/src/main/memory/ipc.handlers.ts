// electron/src/main/memory/ipc.handlers.ts
// memory 命名空间 IPC（spec §7.2）：记忆管理页的 CRUD/检索通道。
// 薄转发层——业务与事务在 storage/memories/*（已测）；总开关走既有 settings:updateGlobal。
import { ipcMain } from 'electron';
import { logger } from '../logger';
import {
  insertMemory, updateMemory, deleteMemory, listMemories,
  type MemoryListScope, type MemoryListFilter, type SaveMemoryInput, type MemoryPatch,
} from '../storage/memories/repo';
import { searchMemories } from '../storage/memories/search';

export type { MemoryListScope, MemoryListFilter, SaveMemoryInput, MemoryPatch };

export function registerMemoryIpc(): void {
  ipcMain.handle('memory:list', (_evt, scope: MemoryListScope, filter?: MemoryListFilter) => {
    return listMemories(scope, filter);
  });

  ipcMain.handle('memory:save', (_evt, input: SaveMemoryInput) => {
    const entry = insertMemory(input);
    logger.info('记忆已保存', { id: entry.id, scope: entry.scope, source: entry.source });
    return entry;
  });

  ipcMain.handle('memory:update', (_evt, id: string, patch: MemoryPatch) => {
    return updateMemory(id, patch);
  });

  ipcMain.handle('memory:delete', (_evt, id: string) => {
    deleteMemory(id);
    return { ok: true as const };
  });

  ipcMain.handle(
    'memory:search',
    (_evt, q: string, scope?: { workspaceId?: string; sessionId?: string }, limit?: number) => {
      // 管理页检索固定本机视角：workspaceId 必填，sessionId 可选
      if (!scope?.workspaceId) return [];
      return searchMemories(q, { workspaceId: scope.workspaceId, sessionId: scope.sessionId ?? null }, limit ?? 20);
    },
  );

  logger.info('Memory IPC handlers 已注册');
}
