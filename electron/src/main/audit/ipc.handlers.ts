// electron/src/main/audit/ipc.handlers.ts
//
// 审计日志查询 IPC —— 把 audit/query.ts 的 getToolCalls 包装成 audit:* 通道。
// 单独成文件（而非塞进 workspace/ipc.handlers.ts）：审计是横切关注点，
// 未来会加入更多审计域（文件操作、权限变更等），独立模块便于演进。

import { ipcMain } from 'electron';
import { logger } from '../logger';
import { getToolCalls, type ToolCallQueryOpts } from './query';

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

  logger.info('Audit IPC handlers 已注册');
}
