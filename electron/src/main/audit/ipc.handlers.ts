// electron/src/main/audit/ipc.handlers.ts
//
// 审计日志 IPC —— 查询走 audit/query.ts，容量配额走 audit/quota.ts。
// 单独成文件（而非塞进 workspace/ipc.handlers.ts）：审计是横切关注点，
// 未来会加入更多审计域（文件操作、权限变更等），独立模块便于演进。

import { ipcMain } from 'electron';
import { logger } from '../logger';
import { getToolCalls, type ToolCallQueryOpts } from './query';
import { getAuditQuotaInfo, setAuditQuota, enforceAuditQuota } from './quota';

/** 注册 audit:* IPC handlers。重复注册会被 Electron 拒绝，故仅调用一次。 */
export function registerAuditHandlers(): void {
  // 分页查询某 workspace 的工具调用审计记录。
  // 入参顺序与 preload 桥对齐：(workspaceId, opts?)。
  ipcMain.handle(
    'audit:getToolCalls',
    async (_evt, workspaceId: string, opts?: ToolCallQueryOpts) => {
      return getToolCalls(workspaceId, opts);
    },
  );

  // P2 Task 8：容量配额三通道（入参顺序与 preload 桥对齐）
  ipcMain.handle('audit:getQuota', async (_evt, workspaceId: string) => {
    return getAuditQuotaInfo(workspaceId);
  });
  // quotaMb = null 清除 workspace 覆盖（回退全局）；非正数在 quota 层抛错
  ipcMain.handle(
    'audit:setQuota',
    async (_evt, workspaceId: string, quotaMb: number | null) => {
      setAuditQuota(workspaceId, quotaMb);
    },
  );
  // 立即执行滚动清理，返回本次删除条数
  ipcMain.handle('audit:enforceNow', async (_evt, workspaceId: string) => {
    return { deletedCount: enforceAuditQuota(workspaceId) };
  });

  logger.info('Audit IPC handlers 已注册');
}
