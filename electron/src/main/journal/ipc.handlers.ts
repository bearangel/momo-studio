// electron/src/main/journal/ipc.handlers.ts
//
// journal 命名空间 IPC（v2.5 变更账本 Task 7）：list / revert / scan /
// rollbackFileBefore 四通道，通道面与 renderer types.d.ts 的 JournalApiSurface
// 双端逐字对齐（momo-boundary-rules：preload ↔ ipcMain 通道名逐一对应）。
//
// 主进程 store 注入（T3 移交）：IPC 层天然运行在主进程——registerJournalIpc()
// 注册即注入 setJournalStore(createJournalStore(getDb()))，通道与 store 生命周期
// 绑定，杜绝「通道注册了但 store 未注入」导致的静默跳过（revert / detector /
// quota 均消费 recorder 模块单例，未注入为 fail-fast）。
//
// 合成 recorderCtx（T3 移交裁定）：revert 的发起者是 UI 用户，无真实
// streamSessionId 语义——固定哨兵 streamSessionId='journal-revert-ui'，使对称
// 条目可追溯来源；taskId / sessionId 置 null（撤销动作不属于任何任务/会话），
// toolName 固定 'undo'（revert 层 recordInverse 亦强制改写，双保险）。

import { ipcMain } from 'electron';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { getWorkspace } from '../workspace/crud';
import { createJournalStore } from './store';
import type { JournalStore } from './store';
import { getJournalStore, setJournalStore } from './recorder';
import type { RecordCtx } from './recorder';
import { revertEntries } from './revert';
import type { RevertOutcome } from './revert';
import { scanUnjournaled } from './detector';
import type { JournalEntry, JournalEntryView } from './types';

/** list 通道 blob 文本截断上限（100KB）：视图不做全量透传，防巨文件撑爆 IPC */
const TEXT_CAP = 100 * 1024;

/** UI 发起撤销的合成记账 ctx（裁定见文件头注释） */
function syntheticUndoCtx(workspaceId: string): RecordCtx {
  return {
    workspaceId,
    taskId: null,
    sessionId: null,
    streamSessionId: 'journal-revert-ui',
    toolName: 'undo',
  };
}

function requireStore(): JournalStore {
  const store = getJournalStore();
  if (!store) {
    throw new Error(
      'journal store 未注入（生产：registerJournalIpc 注册即注入；测试：__setJournalStoreForTest）',
    );
  }
  return store;
}

/** 取 workspace 目录；不存在即抛错（invoke 拒绝，UI 直接呈现中文错误） */
function requireWorkspaceDir(workspaceId: string): string {
  const ws = getWorkspace(workspaceId);
  if (!ws) {
    throw new Error(`工作空间不存在: ${workspaceId}`);
  }
  return ws.directoryPath;
}

/** hash 侧文本：hash 为 null（无内容侧）或 blob 缺失 → null；否则截断 100KB */
function readTextCapped(workspaceId: string, hash: string | null): string | null {
  if (hash === null) return null;
  const content = requireStore().readBlob(workspaceId, hash);
  if (content === null) return null;
  return content.length > TEXT_CAP ? content.slice(0, TEXT_CAP) : content;
}

function toView(workspaceId: string, e: JournalEntry): JournalEntryView {
  return {
    ...e,
    beforeText: readTextCapped(workspaceId, e.beforeHash),
    afterText: readTextCapped(workspaceId, e.afterHash),
  };
}

export function registerJournalIpc(): void {
  // 主进程 store 注入（T3 移交）：注册即注入，revert / detector / quota 共用同一单例
  setJournalStore(createJournalStore(getDb()));

  ipcMain.handle(
    'journal:list',
    async (_e, scope: { workspaceId: string; taskId?: string; streamSessionId?: string }) => {
      const store = requireStore();
      let entries: JournalEntry[];
      if (typeof scope.taskId === 'string') {
        entries = store.listByTask(scope.workspaceId, scope.taskId);
      } else if (typeof scope.streamSessionId === 'string') {
        entries = store.listByStream(scope.workspaceId, scope.streamSessionId);
      } else {
        // 两键皆空：无归组语义 → 空数组（显式 scope 才有显式结果，不猜全量）
        entries = [];
      }
      return entries.map((e) => toView(scope.workspaceId, e));
    },
  );

  ipcMain.handle(
    'journal:revert',
    async (_e, workspaceId: string, ids: string[], opts?: { force?: boolean }) => {
      const workspaceDir = requireWorkspaceDir(workspaceId);
      return revertEntries(workspaceId, workspaceDir, ids, {
        force: opts?.force === true,
        recorderCtx: syntheticUndoCtx(workspaceId),
      });
    },
  );

  ipcMain.handle('journal:scan', async (_e, workspaceId: string, taskId: string | null) => {
    const workspaceDir = requireWorkspaceDir(workspaceId);
    return scanUnjournaled(workspaceId, workspaceDir, taskId);
  });

  ipcMain.handle(
    'journal:rollbackFileBefore',
    async (_e, workspaceId: string, filePath: string, beforeEntryId: string) => {
      const store = requireStore();
      const workspaceDir = requireWorkspaceDir(workspaceId);
      // 锚点条目：不存在（可能已被配额清理）或 path 不一致 → no-op 如实汇报，不静默
      const anchor = store.listByIds(workspaceId, [beforeEntryId])[0] ?? null;
      if (!anchor) {
        const miss: RevertOutcome[] = [
          { id: beforeEntryId, path: filePath, result: 'no-op', detail: '条目不存在（可能已被配额清理）' },
        ];
        return miss;
      }
      if (anchor.path !== filePath) {
        const mismatch: RevertOutcome[] = [
          { id: beforeEntryId, path: filePath, result: 'no-op', detail: `条目 path（${anchor.path}）与传入 path 不一致` },
        ];
        return mismatch;
      }
      // 组合：该 path 上 created_at 晚于锚点的全部条目 + 锚点自身；执行序由
      // revertEntries 内部 created_at DESC 保证（较新先撤）
      const laterIds = store
        .listByPath(workspaceId, filePath)
        .filter((e) => e.createdAt > anchor.createdAt)
        .map((e) => e.id);
      return revertEntries(workspaceId, workspaceDir, [...laterIds, anchor.id], {
        recorderCtx: syntheticUndoCtx(workspaceId),
      });
    },
  );

  logger.info('Journal IPC handlers 已注册');
}
