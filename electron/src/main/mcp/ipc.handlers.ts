// electron/src/main/mcp/ipc.handlers.ts
//
// MCP 相关 IPC handler 注册入口。把 host-manager 的进程池能力包装成 `mcp:*`
// 通道，暴露给渲染进程（UI 与未来的 agent 调度）。
//
// 暴露通道：
//   - mcp:register        注册一条 MCP server 定义到 SQLite（不启动进程）
//   - mcp:listRegistered  v1.6：列出所有已注册 MCP（含 source 区分）
//   - mcp:deleteRegistered v1.6：删除自定义 MCP（marketplace 装的抛错，走卸载按钮）
//   - mcp:start           从 SQLite 读取定义并启动该 workspace 内的 MCP 进程（进程池复用）
//   - mcp:listTools       列出某 workspace 内已启动 MCP 暴露的工具
//   - mcp:callTool        调用某 workspace 内已启动 MCP 的指定工具
//   - mcp:stop            停止某 workspace 内的指定 MCP 进程

import { ipcMain } from 'electron';
import { logger } from '../logger';
import {
  getOrStartMcp,
  listMcpTools,
  callMcpTool,
  stopMcp,
  registerMcpDefinition,
  listRegistered,
  deleteRegistered,
  getMcpConfig,
} from './host-manager';
import type { McpServerConfig } from './types';

/** 注册全部 mcp: 命名空间的 IPC handler。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerMcpHandlers(): void {
  // 注册一条 MCP server 定义（持久化，不启动进程）。name 唯一，重复注册会整体覆盖。
  ipcMain.handle('mcp:register', async (_evt, config: McpServerConfig) => {
    registerMcpDefinition(config);
    return;
  });

  // v1.6：列出所有已注册 MCP（含 source / installedAt），UI 据此区分展示与卸载逻辑。
  ipcMain.handle('mcp:listRegistered', async () => {
    return listRegistered();
  });

  // v1.6：删除自定义 MCP。marketplace 装的抛错（提示用卸载按钮），不存在的 name 静默跳过。
  ipcMain.handle('mcp:deleteRegistered', async (_evt, name: string) => {
    deleteRegistered(name);
    return;
  });

  // 启动某 workspace 内的 MCP 进程（先从 SQLite 读定义）。进程池复用：已启动则直接返回。
  ipcMain.handle(
    'mcp:start',
    async (_evt, workspaceId: string, mcpName: string) => {
      const config = getMcpConfig(mcpName);
      if (!config) throw new Error(`MCP ${mcpName} 未注册`);
      await getOrStartMcp(workspaceId, config);
      return;
    },
  );

  // 列出某 workspace 内已启动 MCP 暴露的工具。未启动会抛错。
  ipcMain.handle(
    'mcp:listTools',
    async (_evt, workspaceId: string, mcpName: string) => {
      return listMcpTools(workspaceId, mcpName);
    },
  );

  // 调用某 workspace 内已启动 MCP 的指定工具，返回拼接后的文本输出。
  ipcMain.handle(
    'mcp:callTool',
    async (
      _evt,
      workspaceId: string,
      mcpName: string,
      toolName: string,
      args: Record<string, unknown>,
    ) => {
      return callMcpTool(workspaceId, mcpName, toolName, args);
    },
  );

  // 停止某 workspace 内的指定 MCP 进程。未启动则静默跳过。
  ipcMain.handle(
    'mcp:stop',
    async (_evt, workspaceId: string, mcpName: string) => {
      await stopMcp(workspaceId, mcpName);
      return;
    },
  );

  logger.info('MCP IPC handlers 已注册');
}
