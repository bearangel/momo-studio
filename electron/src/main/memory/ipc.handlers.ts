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
// v2.2 P3：导出/导入 Markdown（契约冻结——既有五通道不动，本两通道纯追加）
import { exportMemoriesMarkdown, importMemoriesMarkdown } from '../storage/memories/markdown';

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

  // v2.2 P3（spec §7.2）：导出——一层记忆全量 → {filename, content}（renderer 走 Blob 下载，
  // 同 session:exportMessages 消费端）；content 不含凭据（记忆本身即用户/agent 知识资产）
  ipcMain.handle('memory:exportMarkdown', (_evt, scope: MemoryListScope) => {
    return exportMemoriesMarkdown(scope);
  });

  // v2.2 P3（spec §7.2）：导入——逐 `## ` 段解析，source 固定 'user'，坏段/去重计入 skipped；
  // session scope 在 markdown.ts 拒绝（UI 本页仅 global/workspace 两层 tab）
  ipcMain.handle('memory:importMarkdown', (_evt, scope: MemoryListScope, content: string) => {
    const result = importMemoriesMarkdown(scope, content);
    logger.info('记忆 Markdown 导入完成', { scopeKind: scope.kind, ...result });
    return result;
  });

  logger.info('Memory IPC handlers 已注册');
}
